"""Exercise the compiled native shell; fixtures remain in the owned test cache."""
import importlib.util
import hashlib
import ctypes
from ctypes import wintypes
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time
import unittest

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('native_builder', ROOT / 'scripts/build-native.py')
builder = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(builder)


def processes_at(executable):
    """Count actual processes by exact owned fixture path, never by global name."""
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)

    class ProcessEntry(ctypes.Structure):
        _fields_ = [('dwSize', wintypes.DWORD), ('cntUsage', wintypes.DWORD),
                    ('th32ProcessID', wintypes.DWORD), ('th32DefaultHeapID', ctypes.c_size_t),
                    ('th32ModuleID', wintypes.DWORD), ('cntThreads', wintypes.DWORD),
                    ('th32ParentProcessID', wintypes.DWORD), ('pcPriClassBase', wintypes.LONG),
                    ('dwFlags', wintypes.DWORD), ('szExeFile', wintypes.WCHAR * 260)]

    kernel.CreateToolhelp32Snapshot.argtypes = [wintypes.DWORD, wintypes.DWORD]
    kernel.CreateToolhelp32Snapshot.restype = wintypes.HANDLE
    kernel.Process32FirstW.argtypes = [wintypes.HANDLE, ctypes.POINTER(ProcessEntry)]
    kernel.Process32NextW.argtypes = [wintypes.HANDLE, ctypes.POINTER(ProcessEntry)]
    kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel.OpenProcess.restype = wintypes.HANDLE
    kernel.QueryFullProcessImageNameW.argtypes = [wintypes.HANDLE, wintypes.DWORD,
                                                wintypes.LPWSTR, ctypes.POINTER(wintypes.DWORD)]
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    snapshot = kernel.CreateToolhelp32Snapshot(2, 0)
    if snapshot == wintypes.HANDLE(-1).value:
        raise ctypes.WinError(ctypes.get_last_error())
    result = []
    expected = str(executable.resolve()).casefold()
    try:
        entry = ProcessEntry()
        entry.dwSize = ctypes.sizeof(entry)
        available = kernel.Process32FirstW(snapshot, ctypes.byref(entry))
        while available:
            handle = kernel.OpenProcess(0x1000, False, entry.th32ProcessID)
            if handle:
                try:
                    size = wintypes.DWORD(32768)
                    path = ctypes.create_unicode_buffer(size.value)
                    if kernel.QueryFullProcessImageNameW(handle, 0, path, ctypes.byref(size)):
                        if path.value.casefold() == expected:
                            result.append(entry.th32ProcessID)
                finally:
                    kernel.CloseHandle(handle)
            available = kernel.Process32NextW(snapshot, ctypes.byref(entry))
    finally:
        kernel.CloseHandle(snapshot)
    return result


def window_for(pid):
    user = ctypes.WinDLL('user32', use_last_error=True)
    callback_type = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    user.EnumWindows.argtypes = [callback_type, wintypes.LPARAM]
    user.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
    user.GetWindowTextW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
    matches = []

    @callback_type
    def visit(window, _):
        owner = wintypes.DWORD()
        user.GetWindowThreadProcessId(window, ctypes.byref(owner))
        if owner.value == pid:
            title = ctypes.create_unicode_buffer(256)
            user.GetWindowTextW(window, title, len(title))
            if title.value == '截图组卷':
                matches.append(window)
        return True

    user.EnumWindows(visit, 0)
    return matches[0] if matches else None


@unittest.skipUnless(os.name == 'nt', 'Windows host tests')
class NativeHost(unittest.TestCase):
    def setUp(self):
        self.cache = ROOT / '.cache' / 'native-tests'
        self.cache.mkdir(parents=True, exist_ok=True)
        self.fixture = Path(tempfile.mkdtemp(prefix='host-', dir=self.cache))
        for name in ['截图组卷.exe', *builder.SDK_FILES.values()]:
            shutil.copy2(ROOT / 'dist' / name, self.fixture / name)

    def tearDown(self):
        if not self.fixture.resolve().is_relative_to(self.cache.resolve()):
            self.fail('Unexpected fixture cleanup path')
        for _ in range(30):
            try:
                shutil.rmtree(self.fixture)
                return
            except OSError as error:
                if not self.fixture.exists():
                    return
                if getattr(error, 'winerror', None) not in {2, 3, 5, 32, 145}:
                    raise
                time.sleep(.1)

    def make_worker_fixture(self):
        worker_dir = self.fixture / 'resources/python'
        worker_dir.mkdir(parents=True)
        (self.fixture / 'worker').mkdir()
        (self.fixture / 'worker/service.py').write_text('# transport fixture', encoding='utf-8')
        worker = r'''using System;using System.Diagnostics;using System.IO;using System.Text;using System.Threading;
class Worker {static void Main(){Console.InputEncoding=Encoding.UTF8;Console.OutputEncoding=Encoding.UTF8;
string root=Environment.GetEnvironmentVariable("PAPER_STUDIO_DATA_DIR");Directory.CreateDirectory(root);
File.AppendAllText(Path.Combine(root,"worker-starts.txt"),Process.GetCurrentProcess().Id+"\n",new UTF8Encoding(false));
Console.WriteLine("{\"type\":\"event\",\"event\":\"worker-state\",\"state\":\"ready\"}");
File.WriteAllText(Path.Combine(root,"worker-trace.json"),Console.ReadLine(),new UTF8Encoding(false));
Thread.Sleep(30000);}}'''
        (self.fixture / 'Worker.cs').write_text(worker, encoding='utf-8-sig')
        csc = Path(os.environ['WINDIR']) / 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
        subprocess.run([str(csc), '/nologo', '/target:exe', '/platform:x64',
                        '/out:' + str(worker_dir / 'python.exe'), str(self.fixture / 'Worker.cs')], check=True, capture_output=True)

    def await_condition(self, callback, timeout=30):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            result = callback()
            if result:
                return result
            time.sleep(.05)
        self.fail('Timed out waiting for the owned native fixture')

    def probe(self, with_worker=False):
        source = r'''
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
class Probe {
 [STAThread] static void Main(string[] args) {
  Console.OutputEncoding=new UTF8Encoding(false);
  Assembly a=Assembly.LoadFrom(args[0]); Type t=a.GetType("ScreenshotStudio.Shell");
  BindingFlags stat=BindingFlags.NonPublic|BindingFlags.Static;
  BindingFlags inst=BindingFlags.NonPublic|BindingFlags.Instance;
  var local=t.GetMethod("LocalUri",stat); var resource=t.GetMethod("ResourceUri",stat);
  var result=new Dictionary<string,object>();
  var program=a.GetType("ScreenshotStudio.Program");var key=program.GetField("InstanceKey",stat);
  result["instanceKey"]=key==null?null:key.GetValue(null);
  result["maxBridge"]=program.GetField("MaxJson",stat).GetRawConstantValue();
  result["maxProject"]=program.GetField("MaxProject",stat).GetRawConstantValue();
  foreach(string uri in new[]{"https://paper.local/index.html","https://paper.local:443/app.js","http://paper.local/","https://paper.local.evil/","https://evil.example/","file:///C:/secret","https://user@paper.local/"})
   result[uri]=local.Invoke(null,new object[]{uri});
  result["dataImage"]=resource.Invoke(null,new object[]{"data:image/png;base64,AA=="});
  result["foreignBlob"]=resource.Invoke(null,new object[]{"blob:https://evil.example/abc"});
  object shell=Activator.CreateInstance(t,inst,null,new object[]{Stopwatch.StartNew(),false,null,null},null);
  SynchronizationContext.SetSynchronizationContext(null);
  if(File.Exists(Path.Combine(Path.GetDirectoryName(args[0]),"resources","python","python.exe"))) {
   Console.InputEncoding=Encoding.GetEncoding(936);
   var payload=new Dictionary<string,object>{{"method","status"},{"params",new Dictionary<string,object>{{"word","中文−测试"}}}};
   ((Task)t.GetMethod("ForwardWorkerAsync",inst).Invoke(shell,new object[]{"utf8-test",payload})).GetAwaiter().GetResult();
   string trace=Path.Combine(Path.GetDirectoryName(args[0]),"data","worker-trace.json");
   for(int i=0;i<100 && !File.Exists(trace);i++)Thread.Sleep(50);
   result["workerTrace"]=File.Exists(trace)?File.ReadAllText(trace,Encoding.UTF8):"";
   Process child=(Process)t.GetField("worker",inst).GetValue(shell);int pid=child.Id;
   ((IDisposable)shell).Dispose();
   bool stopped;try{using(var p=Process.GetProcessById(pid))stopped=p.HasExited;}catch(ArgumentException){stopped=true;}
   result["workerStopped"]=stopped;
   if(!stopped)try{Process.GetProcessById(pid).Kill();}catch{}
   Console.WriteLine(new JavaScriptSerializer().Serialize(result));return;
  }
  try {
   var ensure=(Task)t.GetMethod("EnsureWorkerAsync",inst).Invoke(shell,null);
   try { ensure.GetAwaiter().GetResult();result["missingWorkerRejected"]=false; }
   catch(System.IO.FileNotFoundException){result["missingWorkerRejected"]=true;}
   result["missingWorkerState"]=t.GetField("workerState",inst).GetValue(shell);
   var current=Process.GetCurrentProcess();
   t.GetField("worker",inst).SetValue(shell,current);
   t.GetField("workerState",inst).SetValue(shell,"ready");
   t.GetMethod("WorkerExited",inst).Invoke(shell,new object[]{Process.GetCurrentProcess()});
   result["staleExitState"]=t.GetField("workerState",inst).GetValue(shell);
   t.GetField("worker",inst).SetValue(shell,null);
  } finally { ((IDisposable)shell).Dispose(); }
  Console.WriteLine(new JavaScriptSerializer().Serialize(result));
 }
}
'''
        (self.fixture / 'Probe.cs').write_text(source, encoding='utf-8-sig')
        csc = Path(os.environ['WINDIR']) / 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
        if with_worker:
            self.make_worker_fixture()
        subprocess.run([str(csc), '/nologo', '/target:exe', '/platform:x64', '/reference:System.Web.Extensions.dll',
                        '/out:' + str(self.fixture / 'Probe.exe'), str(self.fixture / 'Probe.cs')], check=True, capture_output=True)
        completed = subprocess.run([str(self.fixture / 'Probe.exe'), str(self.fixture / '截图组卷.exe')],
                                   check=True, capture_output=True, encoding='utf-8', timeout=15, creationflags=0x08000000)
        return json.loads(completed.stdout)

    def test_local_origin_and_missing_worker_do_not_require_a_model(self):
        result = self.probe()
        self.assertTrue(result['https://paper.local/index.html'])
        self.assertTrue(result['https://paper.local:443/app.js'])
        for value in ['http://paper.local/', 'https://paper.local.evil/', 'https://evil.example/',
                      'file:///C:/secret', 'https://user@paper.local/']:
            self.assertFalse(result[value], value)
        self.assertTrue(result['dataImage'])
        self.assertFalse(result['foreignBlob'])
        self.assertTrue(result['missingWorkerRejected'])
        self.assertEqual(result['missingWorkerState'], 'error')

    def test_an_old_worker_exit_cannot_fail_a_replacement_worker(self):
        self.assertEqual(self.probe()['staleExitState'], 'ready')

    def test_instance_identity_is_stable_for_the_absolute_exe_directory(self):
        expected = hashlib.sha256(str(self.fixture.resolve()).rstrip('\\/').upper().encode('utf-8')).hexdigest()
        result = self.probe()
        self.assertEqual(result['instanceKey'], expected)
        self.assertEqual(result['maxBridge'], 96 * 1024 * 1024)
        self.assertEqual(result['maxProject'], 72 * 1024 * 1024)

    def test_worker_transport_is_utf8_and_disposal_stops_the_owned_process(self):
        result = self.probe(with_worker=True)
        trace = json.loads(result['workerTrace'])
        self.assertEqual(trace['params']['word'], '中文−测试')
        self.assertTrue(result['workerStopped'])

    def test_real_double_launch_activates_one_host_and_one_worker_and_does_not_block_self_test(self):
        self.make_worker_fixture()
        ui = self.fixture / 'ui'
        ui.mkdir()
        (ui / 'index.html').write_text('''<!doctype html><meta charset="utf-8"><input id="title" value="单实例验收">
<script>requestAnimationFrame(()=>requestAnimationFrame(()=>chrome.webview.postMessage({
id:'ready-fixture',command:'ready',payload:{titleEditable:true,sourceCount:0}})));
setTimeout(()=>chrome.webview.postMessage({id:'status-fixture',command:'worker',payload:{method:'status',params:{}}}),1500);</script>''', encoding='utf-8')
        executable = self.fixture / '截图组卷.exe'
        worker_executable = self.fixture / 'resources/python/python.exe'
        first = subprocess.Popen([str(executable)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                 creationflags=0x08000000)
        window = None
        try:
            window = self.await_condition(lambda: window_for(first.pid))
            # Click again as soon as the native handle exists, before WebView has to finish loading.
            second = subprocess.run([str(executable)], timeout=10, capture_output=True, creationflags=0x08000000)
            self.assertEqual(second.returncode, 0)
            self.assertIsNone(first.poll())
            log = self.fixture / 'data/logs/native.log'
            self.await_condition(lambda: log.exists() and 'window-activate' in log.read_text(encoding='utf-8'))
            self.await_condition(lambda: log.exists() and 'ui-ready' in log.read_text(encoding='utf-8'))
            starts = self.fixture / 'data/worker-starts.txt'
            self.await_condition(lambda: starts.exists() and starts.read_text(encoding='utf-8').strip())
            hosts, workers = processes_at(executable), processes_at(worker_executable)
            self.assertEqual(hosts, [first.pid])
            self.assertEqual(len(workers), 1)
            self.assertEqual(starts.read_text(encoding='utf-8').splitlines(), [str(workers[0])])
            result = self.fixture / 'independent-startup.json'
            independent = subprocess.run([str(executable), '--self-test-startup', '--result', str(result)],
                                         timeout=40, capture_output=True, creationflags=0x08000000)
            self.assertEqual(independent.returncode, 0)
            actual = json.loads(result.read_text(encoding='utf-8'))
            self.assertTrue(actual['passed'], actual)
            self.assertFalse(actual['workerStarted'])
            self.assertEqual(processes_at(executable), [first.pid])
            self.assertEqual(processes_at(worker_executable), workers)
            print(json.dumps({'nativeDoubleLaunch': {'hostCount': len(hosts), 'workerCount': len(workers),
                  'activationReceived': True, 'selfTestIndependent': True, 'selfTestUiReadyMs': actual['uiReadyMs']}}, ensure_ascii=False))
        finally:
            if first.poll() is None:
                if window:
                    user = ctypes.WinDLL('user32', use_last_error=True)
                    user.PostMessageW.argtypes = [wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM]
                    user.PostMessageW(window, 0x10, 0, 0)
                try:
                    first.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    first.terminate()
                    first.wait(timeout=10)
        self.await_condition(lambda: not processes_at(worker_executable), timeout=5)

    def test_actual_webview_reports_an_editable_ui_without_worker_assets(self):
        ui = self.fixture / 'ui'
        ui.mkdir()
        (ui / 'index.html').write_text('''<!doctype html><meta charset="utf-8"><input id="title" value="新工作台">
<script>requestAnimationFrame(()=>requestAnimationFrame(()=>window.chrome.webview.postMessage({
id:'ready-fixture',command:'ready',payload:{titleEditable:!document.querySelector('#title').disabled,sourceCount:0}})));</script>''', encoding='utf-8')
        result = self.fixture / 'startup.json'
        completed = subprocess.run([str(self.fixture / '截图组卷.exe'), '--self-test-startup', '--result', str(result)],
                                   timeout=40, capture_output=True, creationflags=0x08000000)
        self.assertTrue(result.exists(), completed.stderr.decode(errors='replace'))
        actual = json.loads(result.read_text(encoding='utf-8'))
        print(json.dumps({'nativeStartupFixture': actual}, ensure_ascii=False))
        self.assertTrue(actual['passed'], actual)
        self.assertTrue(actual['titleEditable'])
        self.assertFalse(actual['workerStarted'])
        self.assertEqual(actual['workerState'], 'idle')
        self.assertLess(actual['uiReadyMs'], 10000)
        self.assertEqual(Path(actual['dataRoot']), self.fixture / 'data')
        self.assertEqual(completed.returncode, 0)

    def pdf_fixture(self, content):
        ui = self.fixture / 'ui'
        ui.mkdir(exist_ok=True)
        (ui / 'index.html').write_text('''<!doctype html><meta charset="utf-8"><input id="title">
<script>requestAnimationFrame(()=>window.chrome.webview.postMessage({id:'ready-fixture',command:'ready',payload:{titleEditable:true}}));</script>''', encoding='utf-8')
        html = self.fixture / 'print.html'
        html.write_text(content, encoding='utf-8')
        result = self.fixture / 'pdf-result.json'
        completed = subprocess.run([str(self.fixture / '截图组卷.exe'), '--self-test-pdf', '--html', str(html), '--result', str(result)],
                                   timeout=40, capture_output=True, creationflags=0x08000000)
        self.assertTrue(result.exists(), completed.stderr.decode(errors='replace'))
        return completed, json.loads(result.read_text(encoding='utf-8')), result.with_suffix('.pdf')

    def test_actual_pdf_waits_for_local_styles_fonts_and_images(self):
        ui = self.fixture / 'ui'
        ui.mkdir()
        (ui / 'pixel.svg').write_text('<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="blue"/></svg>')
        shutil.copy2(Path(os.environ['WINDIR']) / 'Fonts/arial.ttf', ui / 'font.ttf')
        (ui / 'print.css').write_text("@font-face{font-family:Fixture;src:url('/font.ttf')}body{font-family:Fixture;font-size:18px}")
        content = '''<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="https://paper.local/print.css">
<p>Native PDF math 1 + 2 = 3</p><img src="https://paper.local/pixel.svg">
<script>Promise.all([document.fonts.ready,...Array.from(document.images).map(i=>i.decode())]).then(()=>window.__printReady=true).catch(()=>window.__printError='图片准备失败');</script>'''
        completed, result, pdf = self.pdf_fixture(content)
        self.assertTrue(result['passed'], result)
        self.assertFalse(result['workerStarted'])
        self.assertGreater(result['pdfBytes'], 1000)
        self.assertEqual(pdf.read_bytes()[:5], b'%PDF-')
        self.assertEqual(completed.returncode, 0)

    def test_print_error_is_reported_without_publishing_a_pdf(self):
        completed, result, pdf = self.pdf_fixture("<p>Invalid print fixture</p><script>window.__printError='校对失败测试';window.__printReady=true;</script>")
        self.assertFalse(result['passed'])
        self.assertIn('校对失败测试', result['error'])
        self.assertFalse(pdf.exists())
        self.assertEqual(completed.returncode, 1)

    def test_missing_print_styles_do_not_succeed_with_fallback_layout(self):
        completed, result, pdf = self.pdf_fixture("<link rel='stylesheet' href='https://paper.local/missing.css'><p>Missing CSS</p><script>window.__printReady=true;</script>")
        self.assertFalse(result['passed'])
        self.assertIn('资源缺失', result['error'])
        self.assertFalse(pdf.exists())
        self.assertEqual(completed.returncode, 1)


if __name__ == '__main__':
    unittest.main()
