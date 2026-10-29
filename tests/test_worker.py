"""Exercise new worker contracts without loading a large model."""
import base64
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import socket
import threading
import time
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'worker'))
from document import questions_from_model, align_source_rows
from service import Service
from vision import Job, VisionEngine, Cancelled


def transcript():
    return {'questions': [{'number': '3', 'top': 20, 'category': '应用题',
                          'lines': ['计算：', r'(1)$\left|-5\right|+(-2026)^0-\sqrt{4}$',
                                    r'(2)$\frac{3a}{2a-1}-\frac{a+1}{2a-1}$'], 'options': []}]}


def receive_http_request(channel):
    """Drain the POST before closing a fixture socket, avoiding a TCP reset."""
    received = b''
    while b'\r\n\r\n' not in received:
        part = channel.recv(16384)
        if not part:
            raise RuntimeError('Fixture request ended before its headers')
        received += part
    headers, body = received.split(b'\r\n\r\n', 1)
    size = next((int(line.split(b':', 1)[1]) for line in headers.split(b'\r\n') if line.lower().startswith(b'content-length:')), 0)
    while len(body) < size:
        part = channel.recv(min(16384, size - len(body)))
        if not part:
            raise RuntimeError('Fixture request ended before its body')
        body += part


class ContractTests(unittest.TestCase):
    def test_title_and_subquestions_remain_three_distinct_blocks(self):
        first = questions_from_model(transcript(), 'source-1')[0]
        blocks = first['blocks']
        self.assertEqual([block['role'] for block in blocks], ['heading', 'subquestion', 'subquestion'])
        self.assertEqual(blocks[0]['text'], '计算：')
        self.assertEqual([block.get('label') for block in blocks], [None, '(1)', '(2)'])
        self.assertTrue(blocks[1]['text'].startswith('$\\left|'))
        self.assertEqual(first['id'], questions_from_model(transcript(), 'source-1')[0]['id'])
        self.assertNotEqual(first['id'], questions_from_model(transcript(), 'source-2')[0]['id'])

    def test_options_keep_original_columns_and_order(self):
        data = transcript()
        data['questions'][0].update(options=[{'label': 'A', 'text': '第一项'}, {'label': 'B', 'text': '第二项'}], optionColumns=2)
        question = questions_from_model(data, 'source')[0]
        self.assertEqual(question['category'], '选择题')
        self.assertEqual(question['blocks'][-1], {'id': question['blocks'][-1]['id'], 'type': 'options', 'columns': 2,
                                                'items': [{'label': 'A', 'text': '第一项'}, {'label': 'B', 'text': '第二项'}]})

    def test_undelimited_formula_rows_are_marked_without_changing_symbols(self):
        data = transcript()
        data['questions'][0]['lines'] = ['计算：', r'(1)|-5|+(-2026)^0-\sqrt{4}', r'(2)\frac{3a}{2a-1}-\frac{a+1}{2a-1}']
        blocks = questions_from_model(data, 'source')[0]['blocks']
        self.assertEqual(blocks[0]['text'], '计算：')
        self.assertEqual(blocks[1]['text'], r'$|-5|+(-2026)^0-\sqrt{4}$')
        self.assertEqual(blocks[2]['text'], r'$\frac{3a}{2a-1}-\frac{a+1}{2a-1}$')

    def test_bad_or_empty_lines_do_not_become_a_silent_fake_question(self):
        for data in [{'questions': []}, {'questions': [{'lines': []}]}, {'questions': [{'stem': 'missing source lines'}]}]:
            with self.assertRaises(ValueError):
                questions_from_model(data, 'source')

    def test_original_number_is_not_repeated_in_question_text(self):
        data = transcript()
        data['questions'][0]['lines'][0] = '3. 计算：'
        question = questions_from_model(data, 'source')[0]
        self.assertEqual(question['originalNumber'], '3')
        self.assertEqual(question['blocks'][0]['text'], '计算：')

    def test_only_ocr_confirmed_same_row_subquestions_are_merged(self):
        data = transcript()
        data['questions'][0]['lines'] = ['如图，求证。', '(1)求证：AE=BD；', '(2)如图2，求∠AED的度数；']
        questions = questions_from_model(data, 'source')
        hints = [{'text': '如图，求证。', 'bbox': [20, 10, 200, 30], 'confidence': .99},
                 {'text': '(1)求证：AE=BD；', 'bbox': [20, 50, 170, 72], 'confidence': .99},
                 {'text': '(2)如图2，求∠AED的度数；', 'bbox': [205, 49, 620, 73], 'confidence': .99}]
        self.assertEqual(align_source_rows(questions, hints), [])
        blocks = questions[0]['blocks']
        self.assertEqual(len(blocks), 2)
        self.assertIn('(1)求证：AE=BD；', blocks[1]['text'])
        self.assertIn('(2)如图2，求∠AED的度数；', blocks[1]['text'])
        self.assertEqual(blocks[1]['role'], 'paragraph')
        self.assertNotIn('label', blocks[1])

    def test_overlapping_formula_boxes_on_different_rows_are_never_merged(self):
        questions = questions_from_model(transcript(), 'source')
        hints = [{'text': '计算：', 'bbox': [51, 30, 106, 49], 'confidence': .99},
                 {'text': r'(1)$\left|-5\right|+(-2026)^0-\sqrt{4}$', 'bbox': [48, 52, 216, 82], 'confidence': .99},
                 {'text': r'(2)$\frac{3a}{2a-1}-\frac{a+1}{2a-1}$', 'bbox': [45, 72, 165, 115], 'confidence': .99}]
        self.assertEqual(align_source_rows(questions, hints), [])
        self.assertEqual(len(questions[0]['blocks']), 3)
        self.assertNotEqual(questions[0]['blocks'][1]['rowId'], questions[0]['blocks'][2]['rowId'])

    def test_stdio_status_never_loads_an_engine(self):
        requests = '\n'.join(json.dumps(value) for value in [
            {'id': 'status', 'method': 'status'}, {'id': 'cancel', 'method': 'cancel', 'params': {'jobId': 'absent'}}]) + '\n'
        result = subprocess.run([sys.executable, '-u', str(ROOT / 'worker/service.py')], input=requests,
                                text=True, encoding='utf-8', capture_output=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        responses = [json.loads(line) for line in result.stdout.splitlines()]
        self.assertEqual(len(responses), 2)
        self.assertEqual(responses[0]['result']['recognition']['state'], 'idle')
        self.assertFalse(responses[0]['result']['recognition']['available'])
        self.assertFalse(responses[1]['result']['cancelled'])

    def test_two_jobs_are_isolated_when_one_is_cancelled(self):
        started = threading.Event()
        class Engine:
            def status(self): return {'state': 'ready', 'available': True}
            def wait(self, job): job.check()
            def request(self, prompt, image, job, deadline, max_tokens=2300):
                if job.id == 'cancel-me':
                    started.set()
                    while not job.cancelled.wait(.01): pass
                    job.check()
                return transcript()
            def close(self): pass
        class Boxes:
            def read(self, data, job): job.check(); return []
        messages = []
        service = Service(messages.append, engine=Engine(), boxes=Boxes())
        image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aC1cAAAAASUVORK5CYII='
        try:
            for job_id in ['cancel-me', 'keep-me']:
                service.dispatch({'id': job_id, 'method': 'recognize', 'params': {'jobId': job_id, 'sourceId': job_id, 'imageDataUrl': image}})
            self.assertTrue(started.wait(2))
            service.dispatch({'id': 'cancel-command', 'method': 'cancel', 'params': {'jobId': 'cancel-me'}})
            end = time.monotonic() + 3
            while time.monotonic() < end and len([item for item in messages if item['type'] == 'response']) < 3:
                time.sleep(.01)
            responses = {item['id']: item for item in messages if item['type'] == 'response'}
            self.assertEqual(responses['cancel-me']['error']['code'], 'CANCELLED')
            self.assertTrue(responses['keep-me']['ok'])
            self.assertEqual(responses['keep-me']['result']['questions'][0]['sourceId'], 'keep-me')
        finally:
            service.close()

    def test_cancel_interrupts_close_delimited_response_without_blocking_caller(self):
        listening = socket.socket()
        listening.bind(('127.0.0.1', 0))
        listening.listen(1)
        body_started, release_server = threading.Event(), threading.Event()
        errors = []
        def server():
            channel, _ = listening.accept()
            try:
                receive_http_request(channel)
                channel.sendall(b'HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n')
                body_started.set()
                release_server.wait(6)
            finally:
                channel.close()
        def request():
            try:
                engine.request('read', 'data:image/png;base64,AA==', job, time.monotonic() + 15)
            except Exception as error:
                errors.append(error)
        engine = VisionEngine(ROOT / 'dist/resources', parallel=1)
        engine._port, engine._token = listening.getsockname()[1], 'local-test'
        job = Job('cancel-stream')
        host_thread = threading.Thread(target=server, daemon=True)
        request_thread = threading.Thread(target=request, daemon=True)
        try:
            host_thread.start()
            request_thread.start()
            self.assertTrue(body_started.wait(2))
            start = time.monotonic()
            job.cancel()
            self.assertLess(time.monotonic() - start, .5)
            request_thread.join(2)
            if request_thread.is_alive():
                import traceback
                traceback.print_stack(sys._current_frames()[request_thread.ident])
            self.assertFalse(request_thread.is_alive())
            self.assertIsInstance(errors[0], Cancelled)
        finally:
            release_server.set()
            listening.close()
            host_thread.join(2)

    def test_http_chunked_sse_is_decoded_by_the_cancellable_reader(self):
        listening = socket.socket()
        listening.bind(('127.0.0.1', 0))
        listening.listen(1)
        text = json.dumps(transcript(), ensure_ascii=False)
        event = json.dumps({'choices': [{'delta': {'content': text}, 'finish_reason': None}]}, ensure_ascii=False)
        payload = ('data: ' + event + '\n\ndata: [DONE]\n\n').encode('utf-8')
        def server():
            channel, _ = listening.accept()
            try:
                receive_http_request(channel)
                channel.sendall(b'HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n')
                # Split inside both an SSE line and a multibyte Chinese character.
                for byte in payload:
                    channel.sendall(b'1\r\n' + bytes([byte]) + b'\r\n')
                channel.sendall(b'0\r\n\r\n')
            finally:
                channel.close()
        engine = VisionEngine(ROOT / 'dist/resources', parallel=1)
        engine._port, engine._token = listening.getsockname()[1], 'local-test'
        host_thread = threading.Thread(target=server, daemon=True)
        host_thread.start()
        try:
            result = engine.request('read', 'data:image/png;base64,AA==', Job('success'), time.monotonic() + 3)
            self.assertEqual(result, transcript())
        finally:
            listening.close()
            host_thread.join(2)


if __name__ == '__main__':
    unittest.main()
