"""One local CPU vision process, shared bounded slots, cancellable HTTP calls."""
from __future__ import annotations

import http.client
import io
import json
import os
from pathlib import Path
import secrets
import socket
import subprocess
import threading
import time


class Cancelled(Exception):
    pass


class Job:
    def __init__(self, job_id, request_id=None):
        self.id = job_id
        self.request_id = request_id
        self.cancelled = threading.Event()
        self.done = False
        self._lock = threading.Lock()
        self._sockets = set()

    def check(self):
        if self.cancelled.is_set():
            raise Cancelled('已取消本张截图，原图和已有内容保留。')

    def attach(self, channel):
        with self._lock:
            self.check()
            self._sockets.add(channel)

    def detach(self, channel):
        with self._lock:
            self._sockets.discard(channel)

    def cancel(self):
        self.cancelled.set()
        with self._lock:
            for channel in tuple(self._sockets):
                try:
                    channel.shutdown(socket.SHUT_RDWR)
                except OSError:
                    pass


class CancellableReader(io.RawIOBase):
    """Poll cancellation inside raw reads, before HTTP buffering/decoding."""
    def __init__(self, channel, job, deadline):
        self.channel = channel.dup()
        self.channel.settimeout(.2)
        self.job, self.deadline = job, deadline
        try:
            job.attach(self.channel)
        except Exception:
            self.channel.close()
            raise

    def readable(self):
        return True

    def readinto(self, target):
        while True:
            self.job.check()
            if time.monotonic() >= self.deadline:
                raise TimeoutError('本张截图处理超时，原图和已有内容已保留。')
            try:
                return self.channel.recv_into(target)
            except socket.timeout:
                continue
            except OSError:
                self.job.check()
                raise

    def close(self):
        if not self.closed:
            self.job.detach(self.channel)
            self.channel.close()
        super().close()


class CancellableSocket:
    def __init__(self, channel, job, deadline):
        self.channel, self.job, self.deadline = channel, job, deadline

    def makefile(self, mode):
        if mode != 'rb':
            raise ValueError('Unsupported response stream mode')
        return io.BufferedReader(CancellableReader(self.channel, self.job, self.deadline))


def available_memory():
    if os.name != 'nt':
        return 0
    import ctypes
    class Memory(ctypes.Structure):
        _fields_ = [('length', ctypes.c_ulong), ('load', ctypes.c_ulong),
                    ('total', ctypes.c_ulonglong), ('free', ctypes.c_ulonglong),
                    ('page_total', ctypes.c_ulonglong), ('page_free', ctypes.c_ulonglong),
                    ('virtual_total', ctypes.c_ulonglong), ('virtual_free', ctypes.c_ulonglong),
                    ('extended_free', ctypes.c_ulonglong)]
    memory = Memory()
    memory.length = ctypes.sizeof(memory)
    return memory.free if ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(memory)) else 0


class VisionEngine:
    def __init__(self, resources: Path, notify=lambda value: None, *, parallel=None):
        self.resources = resources
        self.notify = notify
        self.parallel = parallel if parallel is not None else (2 if (os.cpu_count() or 1) >= 8 and available_memory() >= 10 * 1024**3 else 1)
        self.phase, self.message = 'idle', '界面已就绪，识别可在后台准备。'
        self._lock = threading.RLock()
        self._stop = threading.Event()
        self._slots = threading.BoundedSemaphore(self.parallel)
        self._process = None
        self._thread = None
        self._port = None
        self._token = None

    def status(self):
        with self._lock:
            if self.phase == 'ready' and self._process and self._process.poll() is not None:
                self.phase, self.message = 'error', '本机识别进程已停止，可以重试，编辑功能仍可使用。'
            return {'state': self.phase, 'available': self.phase == 'ready', 'concurrency': self.parallel, 'message': self.message}

    def warmup(self):
        with self._lock:
            if self._stop.is_set():
                raise RuntimeError('识别服务已关闭。')
            if self.status()['state'] in ('ready', 'loading'):
                return self.status()
            self.phase, self.message = 'loading', '正在后台准备本机识别，可以先导入截图或编辑。'
            self._thread = threading.Thread(target=self._load, daemon=True, name='vision-prepare')
            self._thread.start()
            return self.status()

    def _state(self, phase, message):
        with self._lock:
            if self._stop.is_set():
                return
            self.phase, self.message = phase, message
        self.notify({'type': 'event', 'event': 'engine', **self.status()})

    def _load(self):
        process = None
        try:
            root = self.resources / 'vision'
            files = {'engine': root / 'llama/llama-server.exe',
                     'model': root / 'Qwen3VL-4B-Instruct-Q4_K_M.gguf',
                     'projector': root / 'mmproj-Qwen3VL-4B-Instruct-Q8_0.gguf'}
            if not all(path.is_file() for path in files.values()):
                raise RuntimeError('本机识别资源不完整，请使用包含 resources 的完整新应用目录。')
            with socket.socket() as probe:
                probe.bind(('127.0.0.1', 0))
                port = probe.getsockname()[1]
            token = secrets.token_hex(32)
            threads = min(8, os.cpu_count() or 1)
            arguments = [str(files['engine']), '-m', str(files['model']), '--mmproj', str(files['projector']),
                         '--host', '127.0.0.1', '--port', str(port), '--alias', 'paper-vision',
                         '-ngl', '0', '--no-mmproj-offload', '--ctx-size', str(self.parallel * 8192),
                         '--parallel', str(self.parallel), '--threads', str(threads), '--threads-batch', str(min(12, os.cpu_count() or 1)),
                         '--batch-size', '512', '--ubatch-size', '128', '--image-max-tokens', '4096', '--no-webui', '--jinja']
            if self._stop.is_set():
                return
            process = subprocess.Popen(arguments, cwd=files['engine'].parent,
                                       env={**os.environ, 'LLAMA_API_KEY': token},
                                       stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                       creationflags=0x08000000 if os.name == 'nt' else 0)
            with self._lock:
                if self._stop.is_set():
                    process.terminate()
                    process.wait(timeout=5)
                    return
                old = self._process
                self._process, self._port, self._token = process, port, token
            if old and old.poll() is None:
                old.terminate()
            deadline = time.monotonic() + 180
            while not self._stop.is_set():
                if process.poll() is not None:
                    raise RuntimeError('本机识别组件未能启动，请检查可用内存和 Microsoft Visual C++ x64 运行库。')
                connection = http.client.HTTPConnection('127.0.0.1', port, timeout=1)
                try:
                    connection.request('GET', '/health', headers={'Authorization': 'Bearer ' + token})
                    if connection.getresponse().status == 200:
                        self._state('ready', '本机识别已就绪。')
                        return
                except (OSError, http.client.HTTPException):
                    pass
                finally:
                    connection.close()
                if time.monotonic() > deadline:
                    raise RuntimeError('本机模型准备超时，可以重试；仍可编辑与导出。')
                self._stop.wait(0.2)
        except Exception as error:
            if process and process.poll() is None:
                process.terminate()
            self._state('error', str(error))

    def wait(self, job):
        self.warmup()
        while True:
            job.check()
            status = self.status()
            if status['available']:
                return
            if status['state'] in ('error', 'closed'):
                raise RuntimeError(status['message'])
            job.cancelled.wait(0.1)

    def request(self, prompt: str, image: str, job: Job, deadline: float, max_tokens=1700):
        while not self._slots.acquire(timeout=0.1):
            job.check()
            if time.monotonic() >= deadline:
                raise TimeoutError('本张截图处理超时，原图和已有内容已保留。')
        connection, channel, response = None, None, None
        try:
            job.check()
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError('本张截图处理超时。')
            connection = http.client.HTTPConnection('127.0.0.1', self._port, timeout=min(45, remaining))
            connection.connect()
            channel = connection.sock
            job.attach(channel)
            connection.response_class = lambda sock, **kwargs: http.client.HTTPResponse(CancellableSocket(sock, job, deadline), **kwargs)
            body = json.dumps({'model': 'paper-vision', 'temperature': 0, 'max_tokens': max_tokens, 'stream': True,
                               'response_format': {'type': 'json_object'},
                               'messages': [{'role': 'system', 'content': prompt},
                                            {'role': 'user', 'content': [{'type': 'image_url', 'image_url': {'url': image}}]}]}, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
            connection.request('POST', '/v1/chat/completions', body,
                               {'Authorization': 'Bearer ' + self._token, 'Content-Type': 'application/json', 'Connection': 'close'})
            response = connection.getresponse()
            if response.status != 200:
                raise RuntimeError('本机视觉模型暂时无法处理该图，请重试或裁小截图。')
            chunks = []
            while True:
                job.check()
                if time.monotonic() >= deadline:
                    raise TimeoutError('本张截图处理超时。')
                line = response.readline()
                if not line:
                    break
                if not line.startswith(b'data:'):
                    continue
                data = line[5:].strip()
                if data == b'[DONE]':
                    continue
                message = json.loads(data)
                choice = message.get('choices', [{}])[0]
                text = choice.get('delta', {}).get('content', '')
                if isinstance(text, str):
                    chunks.append(text)
                if choice.get('finish_reason') == 'length':
                    raise RuntimeError('题目较长，本次转录未完成；请分成较小截图。')
            job.check()
            text = ''.join(chunks).strip()
            if text.startswith('```'):
                text = text.split('\n', 1)[-1].rsplit('```', 1)[0].strip()
            result = json.loads(text)
            if not isinstance(result, dict):
                raise ValueError('模型没有返回题目对象。')
            return result
        except Exception:
            job.check()
            raise
        finally:
            if connection:
                job.detach(channel)
                if response:
                    response.close()
                connection.close()
            self._slots.release()

    def close(self):
        self._stop.set()
        with self._lock:
            self.phase, self.message = 'closed', '本机识别已停止。'
            process = self._process
        if process and process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
        thread = self._thread
        if thread and thread is not threading.current_thread():
            thread.join(timeout=6)
