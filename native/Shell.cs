using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace ScreenshotStudio
{
    internal static class Program
    {
        internal static readonly string Root = Path.GetDirectoryName(typeof(Program).Assembly.Location);
        internal static readonly string Data = Path.Combine(Root, "data");
        internal static readonly string InstanceKey = DirectoryIdentity(Root);
        internal static readonly uint ActivationMessage = RegisterWindowMessage("ScreenshotStudio.Next.Activate." + InstanceKey);
        internal const int MaxJson = 96 * 1024 * 1024;
        internal const int MaxProject = 72 * 1024 * 1024;
        internal static JavaScriptSerializer Serializer() { return new JavaScriptSerializer { MaxJsonLength = MaxJson, RecursionLimit = 100 }; }
        internal static string Json(object value) { return Serializer().Serialize(value); }
        internal static Dictionary<string, object> Parse(string value) { return Serializer().DeserializeObject(value) as Dictionary<string, object>; }
        internal static string Text(Dictionary<string, object> value, string name)
        {
            object result;
            return value != null && value.TryGetValue(name, out result) ? result as string : null;
        }
        internal static bool Flag(Dictionary<string, object> value, string name)
        {
            object result;
            return value != null && value.TryGetValue(name, out result) && result is bool && (bool)result;
        }

        [STAThread]
        private static int Main(string[] args)
        {
            Stopwatch clock = Stopwatch.StartNew();
            bool startupTest = false;
            bool pdfTest = false;
            string result = null, htmlFile = null;
            try
            {
                for (int index = 0; index < args.Length; index++)
                {
                    if (args[index] == "--self-test-startup") startupTest = true;
                    else if (args[index] == "--self-test-pdf") { startupTest = true; pdfTest = true; }
                    else if (args[index] == "--result" && index + 1 < args.Length) result = args[++index];
                    else if (args[index] == "--html" && index + 1 < args.Length) htmlFile = args[++index];
                    else throw new ArgumentException("不支持的启动参数。");
                }
                if (startupTest && (result == null || !Path.IsPathRooted(result))) throw new ArgumentException("启动自检需要绝对结果路径。");
                if (!startupTest && result != null) throw new ArgumentException("结果参数仅适用于自检。");
                if (pdfTest && (htmlFile == null || !Path.IsPathRooted(htmlFile) || !File.Exists(htmlFile) || new FileInfo(htmlFile).Length > 16 * 1024 * 1024 || !result.EndsWith(".json", StringComparison.OrdinalIgnoreCase)))
                    throw new ArgumentException("PDF 自检需要绝对 HTML 路径和 JSON 结果路径。");
                if (!pdfTest && htmlFile != null) throw new ArgumentException("HTML 参数仅适用于 PDF 自检。");
                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                if (startupTest) return RunWindow(clock, true, result, pdfTest ? htmlFile : null);
                using (Mutex instance = new Mutex(false, @"Local\ScreenshotStudio.Next." + InstanceKey))
                {
                    bool owns = false;
                    try { owns = instance.WaitOne(0); } catch (AbandonedMutexException) { owns = true; }
                    if (!owns) { ActivateExisting(); return 0; }
                    try
                    {
                        return RunWindow(clock, false, null, null);
                    }
                    finally { instance.ReleaseMutex(); }
                }
            }
            catch (Exception error)
            {
                if (startupTest) WriteResult(result, new { passed = false, error = error.Message });
                else MessageBox.Show("无法启动截图组卷：" + error.Message, "截图组卷", MessageBoxButtons.OK, MessageBoxIcon.Error);
                return 1;
            }
        }

        private static int RunWindow(Stopwatch clock, bool test, string result, string html)
        {
            using (Shell window = new Shell(clock, test, result, html))
            {
                Application.Run(window);
                return test && !window.StartupPassed ? 1 : 0;
            }
        }
        private static string DirectoryIdentity(string directory)
        {
            string absolute = Path.GetFullPath(directory).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar).ToUpperInvariant();
            using (SHA256 hash = SHA256.Create()) return BitConverter.ToString(hash.ComputeHash(Encoding.UTF8.GetBytes(absolute))).Replace("-", "").ToLowerInvariant();
        }

        internal static void WriteResult(string filename, object value)
        {
            if (filename == null) return;
            Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(filename)));
            File.WriteAllText(filename, Json(value), new UTF8Encoding(false));
        }
        private static void ActivateExisting()
        {
            PostMessage(new IntPtr(0xffff), ActivationMessage, IntPtr.Zero, IntPtr.Zero);
        }
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern uint RegisterWindowMessage(string name);
        [DllImport("user32.dll")] private static extern bool PostMessage(IntPtr window, uint message, IntPtr wparam, IntPtr lparam);
    }

    internal sealed class Shell : Form
    {
        private readonly Stopwatch clock;
        private readonly bool startupTest;
        private readonly string resultPath, uiRoot, profile, pdfFixture;
        private readonly WebView2 view = new WebView2();
        private readonly Label loading = new Label();
        private readonly SemaphoreSlim workerGate = new SemaphoreSlim(1, 1), writeGate = new SemaphoreSlim(1, 1), printGate = new SemaphoreSlim(1, 1);
        private readonly HashSet<string> pending = new HashSet<string>(StringComparer.Ordinal);
        private readonly object pendingLock = new object(), logLock = new object();
        private readonly CancellationTokenSource stop = new CancellationTokenSource();
        private readonly Job job = new Job();
        private Process worker;
        private StreamWriter workerInput;
        private bool uiReady, closing, workerStarted;
        internal bool StartupPassed { get; private set; }
        private string workerState = "idle";
        private CoreWebView2Environment environment;
        private System.Windows.Forms.Timer testTimeout;
        private static readonly Regex RequestId = new Regex(@"\A[A-Za-z0-9_.:-]{1,120}\z", RegexOptions.CultureInvariant);
        private static readonly HashSet<string> WorkerMethods = new HashSet<string>(new[] { "status", "recognize", "cancel", "exportWord", "warmup", "shutdown" }, StringComparer.Ordinal);

        internal Shell(Stopwatch timer, bool test, string result, string pdfInput = null)
        {
            clock = timer; startupTest = test; resultPath = result; pdfFixture = pdfInput;
            uiRoot = Path.Combine(Program.Root, "ui");
            profile = startupTest ? Path.Combine(Program.Data, "temp", "startup-" + Guid.NewGuid().ToString("N")) : Path.Combine(Program.Data, "profile");
            Text = "截图组卷"; ClientSize = new Size(1440, 980); MinimumSize = new Size(980, 680);
            StartPosition = FormStartPosition.CenterScreen; BackColor = Color.FromArgb(245, 247, 247);
            Font = new Font("Microsoft YaHei UI", 9F); AutoScaleMode = AutoScaleMode.Dpi;
            loading.Text = "正在打开工作台…"; loading.Dock = DockStyle.Fill; loading.TextAlign = ContentAlignment.MiddleCenter;
            view.Dock = DockStyle.Fill; Controls.Add(view); Controls.Add(loading);
            Shown += async delegate { await InitializeAsync(); };
            FormClosing += delegate { closing = true; stop.Cancel(); };
            FormClosed += delegate { StopOwnedProcesses(); };
            if (startupTest) { ShowInTaskbar = false; Opacity = 0; }
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing) StopOwnedProcesses();
            base.Dispose(disposing);
        }
        protected override void WndProc(ref Message message)
        {
            if (!startupTest && (uint)message.Msg == Program.ActivationMessage)
            {
                if (WindowState == FormWindowState.Minimized) WindowState = FormWindowState.Normal;
                Show(); Activate(); Log("window-activate", clock.ElapsedMilliseconds);
            }
            base.WndProc(ref message);
        }
        private void StopOwnedProcesses()
        {
            closing = true; stop.Cancel();
            if (testTimeout != null) { testTimeout.Dispose(); testTimeout = null; }
            job.Dispose();
            if (workerInput != null) { try { workerInput.Dispose(); } catch { } workerInput = null; }
            if (worker != null) { try { worker.WaitForExit(1500); } catch { } worker.Dispose(); worker = null; }
        }

        private async Task InitializeAsync()
        {
            try
            {
                if (!File.Exists(Path.Combine(uiRoot, "index.html"))) throw new FileNotFoundException("缺少工作台文件，请完整解压程序文件夹。");
                Directory.CreateDirectory(profile); Directory.CreateDirectory(Path.Combine(Program.Data, "temp"));
                CoreWebView2EnvironmentOptions options = new CoreWebView2EnvironmentOptions("--disable-background-networking --disable-component-update --no-default-browser-check");
                environment = await CoreWebView2Environment.CreateAsync(null, profile, options);
                await view.EnsureCoreWebView2Async(environment);
                Configure(view.CoreWebView2, true);
                view.CoreWebView2.WebMessageReceived += OnMessage;
                view.CoreWebView2.NavigationCompleted += delegate(object sender, CoreWebView2NavigationCompletedEventArgs args)
                {
                    if (!args.IsSuccess && args.WebErrorStatus != CoreWebView2WebErrorStatus.OperationCanceled)
                        FailStartup("工作台资源加载失败（" + args.WebErrorStatus + "）。");
                };
                view.Source = new Uri("https://paper.local/index.html");
                if (startupTest)
                {
                    testTimeout = new System.Windows.Forms.Timer { Interval = 30000 };
                    testTimeout.Tick += delegate { testTimeout.Stop(); FailStartup("工作台未在限定时间内就绪。"); };
                    testTimeout.Start();
                }
            }
            catch (Exception error) { FailStartup(error.Message); }
        }

        internal static bool LocalUri(string value)
        {
            Uri uri;
            return Uri.TryCreate(value, UriKind.Absolute, out uri) && uri.Scheme == "https" && uri.Host == "paper.local" && uri.IsDefaultPort && String.IsNullOrEmpty(uri.UserInfo);
        }
        internal static bool ResourceUri(string value)
        {
            return LocalUri(value) || value.StartsWith("data:", StringComparison.OrdinalIgnoreCase) || value.StartsWith("blob:https://paper.local/", StringComparison.OrdinalIgnoreCase);
        }
        private static bool PrinterUri(string value)
        {
            Uri uri;
            return Uri.TryCreate(value, UriKind.Absolute, out uri) && uri.Scheme == "https" && uri.Host == "print.paper.local" && uri.IsDefaultPort && String.IsNullOrEmpty(uri.UserInfo);
        }
        private void Configure(CoreWebView2 core, bool messages)
        {
            core.SetVirtualHostNameToFolderMapping("paper.local", uiRoot, messages ? CoreWebView2HostResourceAccessKind.DenyCors : CoreWebView2HostResourceAccessKind.Allow);
            core.Settings.AreDefaultContextMenusEnabled = false; core.Settings.AreDevToolsEnabled = false;
            core.Settings.AreHostObjectsAllowed = false; core.Settings.IsStatusBarEnabled = false;
            core.Settings.IsWebMessageEnabled = messages;
            core.NavigationStarting += delegate(object sender, CoreWebView2NavigationStartingEventArgs args) { if (!LocalUri(args.Uri) && (messages || !PrinterUri(args.Uri))) args.Cancel = true; };
            core.NewWindowRequested += delegate(object sender, CoreWebView2NewWindowRequestedEventArgs args) { args.Handled = true; };
            core.PermissionRequested += delegate(object sender, CoreWebView2PermissionRequestedEventArgs args) { args.State = CoreWebView2PermissionState.Deny; };
            core.DownloadStarting += delegate(object sender, CoreWebView2DownloadStartingEventArgs args) { args.Cancel = true; };
            core.AddWebResourceRequestedFilter("*", CoreWebView2WebResourceContext.All);
            core.WebResourceRequested += delegate(object sender, CoreWebView2WebResourceRequestedEventArgs args)
            {
                if (!ResourceUri(args.Request.Uri) && (messages || !PrinterUri(args.Request.Uri))) args.Response = environment.CreateWebResourceResponse(new MemoryStream(new byte[0]), 403, "Forbidden", "Content-Type: text/plain");
            };
        }

        private async void OnMessage(object sender, CoreWebView2WebMessageReceivedEventArgs args)
        {
            string id = null;
            try
            {
                if (!LocalUri(args.Source) || args.WebMessageAsJson.Length > Program.MaxJson) throw new InvalidDataException("无效的本机消息。");
                Dictionary<string, object> request = Program.Parse(args.WebMessageAsJson);
                id = Program.Text(request, "id"); string command = Program.Text(request, "command");
                if (id == null || !RequestId.IsMatch(id) || command == null) throw new InvalidDataException("请求标识无效。");
                object raw; Dictionary<string, object> payload = request.TryGetValue("payload", out raw) ? raw as Dictionary<string, object> : null;
                payload = payload ?? new Dictionary<string, object>();
                if (command == "ready") { HandleReady(id, payload); return; }
                if (startupTest) throw new InvalidOperationException("启动自检不会访问文件或启动识别服务。");
                if (command == "worker") { await ForwardWorkerAsync(id, payload); return; }
                object result;
                if (command == "openProject") result = OpenProject();
                else if (command == "saveProject") result = SaveProject(payload);
                else if (command == "saveFile") result = SaveDocument(payload);
                else if (command == "exportPdf") result = await ExportPdfAsync(payload);
                else throw new InvalidDataException("不支持的操作。");
                Reply(id, true, result, null);
            }
            catch (Exception error) { if (id != null && RequestId.IsMatch(id)) Reply(id, false, null, error.Message); }
        }

        private void HandleReady(string id, Dictionary<string, object> payload)
        {
            if (!Program.Flag(payload, "titleEditable")) throw new InvalidDataException("工作台尚未完成初始化。");
            if (!uiReady)
            {
                uiReady = true; loading.Visible = false; view.BringToFront();
                long readyMs = clock.ElapsedMilliseconds; Log("ui-ready", readyMs);
                if (startupTest)
                {
                    if (testTimeout != null) testTimeout.Stop();
                    if (pdfFixture != null) { Task running = RunPdfTestAsync(readyMs); }
                    else
                    {
                        StartupPassed = true;
                        Program.WriteResult(resultPath, new { passed = true, uiReadyMs = readyMs, elapsedMs = clock.ElapsedMilliseconds,
                            titleEditable = true, workerStarted = workerStarted, workerState = workerState, dataRoot = Program.Data,
                            sourceCount = payload.ContainsKey("sourceCount") ? payload["sourceCount"] : 0 });
                        BeginInvoke(new Action(Close));
                    }
                }
                else
                {
                    Task.Delay(1000, stop.Token).ContinueWith(async task => { if (!task.IsCanceled) { try { await EnsureWorkerAsync(); } catch { } } }, TaskScheduler.Default);
                }
            }
            Reply(id, true, new { uiReadyMs = clock.ElapsedMilliseconds, workerState = workerState }, null);
        }

        private async Task RunPdfTestAsync(long readyMs)
        {
            try
            {
                string output = Path.ChangeExtension(Path.GetFullPath(resultPath), ".pdf");
                if (String.Equals(output, Path.GetFullPath(pdfFixture), StringComparison.OrdinalIgnoreCase)) throw new IOException("PDF 结果不能覆盖输入文件。");
                await PrintPdfAsync(File.ReadAllText(pdfFixture, Encoding.UTF8), output);
                byte[] signature = new byte[5];
                using (FileStream stream = File.OpenRead(output)) { if (stream.Read(signature, 0, 5) != 5 || Encoding.ASCII.GetString(signature) != "%PDF-" || stream.Length < 1000) throw new IOException("PDF 输出格式无效。"); }
                StartupPassed = true;
                Program.WriteResult(resultPath, new { passed = true, pdfPath = output, pdfBytes = new FileInfo(output).Length,
                    uiReadyMs = readyMs, elapsedMs = clock.ElapsedMilliseconds, workerStarted = workerStarted, titleEditable = true });
                BeginInvoke(new Action(Close));
            }
            catch (Exception error) { FailStartup(error.Message); }
        }

        private static string Filename(string name, string fallback, string extension)
        {
            name = String.IsNullOrWhiteSpace(name) ? fallback : Path.GetFileName(name);
            foreach (char invalid in Path.GetInvalidFileNameChars()) name = name.Replace(invalid, '_');
            if (String.IsNullOrWhiteSpace(name) || name.Length > 180) name = fallback;
            if (!name.EndsWith(extension, StringComparison.OrdinalIgnoreCase)) name += extension;
            return name;
        }
        private object OpenProject()
        {
            using (OpenFileDialog dialog = new OpenFileDialog { Title = "打开试卷工程", Filter = "试卷工程|*.paper.json;*.json", CheckFileExists = true, Multiselect = false })
            {
                if (dialog.ShowDialog(this) != DialogResult.OK) return new { cancelled = true };
                if (new FileInfo(dialog.FileName).Length > Program.MaxProject) throw new InvalidDataException("工程文件过大。");
                string content = File.ReadAllText(dialog.FileName, Encoding.UTF8);
                Program.Serializer().DeserializeObject(content);
                return new { cancelled = false, json = content, fileName = Path.GetFileName(dialog.FileName) };
            }
        }
        private object SaveProject(Dictionary<string, object> payload)
        {
            string content = Program.Text(payload, "json");
            if (content == null || Encoding.UTF8.GetByteCount(content) > Program.MaxProject) throw new InvalidDataException("工程内容无效或过大。");
            Program.Serializer().DeserializeObject(content);
            return SaveBytes(Encoding.UTF8.GetBytes(content), Filename(Program.Text(payload, "fileName"), "我的试卷.paper.json", ".paper.json"), "试卷工程|*.paper.json");
        }
        private object SaveDocument(Dictionary<string, object> payload)
        {
            string encoded = Program.Text(payload, "base64");
            if (Program.Text(payload, "kind") != "docx" || encoded == null || encoded.Length > 44 * 1024 * 1024) throw new InvalidDataException("文档内容无效或过大。");
            byte[] content = Convert.FromBase64String(encoded);
            if (content.Length > 32 * 1024 * 1024 || content.Length < 4 || content[0] != 80 || content[1] != 75) throw new InvalidDataException("Word 文档格式无效。");
            return SaveBytes(content, Filename(Program.Text(payload, "fileName"), "我的试卷.docx", ".docx"), "Word 文档|*.docx");
        }
        private object SaveBytes(byte[] content, string filename, string filter)
        {
            using (SaveFileDialog dialog = new SaveFileDialog { Title = "保存文件", FileName = filename, Filter = filter, OverwritePrompt = true })
            {
                if (dialog.ShowDialog(this) != DialogResult.OK) return new { cancelled = true };
                File.WriteAllBytes(dialog.FileName, content);
                return new { cancelled = false, fileName = Path.GetFileName(dialog.FileName), path = dialog.FileName };
            }
        }

        private async Task<object> ExportPdfAsync(Dictionary<string, object> payload)
        {
            string html = Program.Text(payload, "html");
            if (html == null || Encoding.UTF8.GetByteCount(html) > 16 * 1024 * 1024) throw new InvalidDataException("打印内容无效或过大。");
            string destination;
            using (SaveFileDialog dialog = new SaveFileDialog { Title = "导出 PDF", FileName = Filename(Program.Text(payload, "fileName"), "我的试卷.pdf", ".pdf"), Filter = "PDF 文档|*.pdf", OverwritePrompt = true })
            {
                if (dialog.ShowDialog(this) != DialogResult.OK) return new { cancelled = true };
                destination = dialog.FileName;
            }
            return await PrintPdfAsync(html, destination);
        }
        private async Task<object> PrintPdfAsync(string html, string destination)
        {
            await printGate.WaitAsync(stop.Token);
            string temporary = Path.Combine(Program.Data, "temp", "print-" + Guid.NewGuid().ToString("N"));
            try
            {
                Directory.CreateDirectory(temporary);
                File.WriteAllText(Path.Combine(temporary, "index.html"), html, new UTF8Encoding(true));
                using (Form printForm = new Form { ShowInTaskbar = false, Opacity = 0, Width = 900, Height = 1200 })
                using (WebView2 printView = new WebView2 { Dock = DockStyle.Fill })
                {
                    printForm.Controls.Add(printView); printForm.Show(this);
                    await printView.EnsureCoreWebView2Async(environment); Configure(printView.CoreWebView2, false);
                    printView.CoreWebView2.SetVirtualHostNameToFolderMapping("print.paper.local", temporary, CoreWebView2HostResourceAccessKind.DenyCors);
                    await printView.CoreWebView2.AddScriptToExecuteOnDocumentCreatedAsync("window.__nativePrintResourceError=false;window.addEventListener('error',function(e){if(e.target&&/^(LINK|SCRIPT|IMG)$/.test(e.target.tagName||''))window.__nativePrintResourceError=true;},true);if(document.fonts)document.fonts.addEventListener('loadingerror',function(){window.__nativePrintResourceError=true;});");
                    bool failedResource = false;
                    printView.CoreWebView2.WebResourceResponseReceived += delegate(object sender, CoreWebView2WebResourceResponseReceivedEventArgs args)
                    {
                        if (LocalUri(args.Request.Uri) && args.Response.StatusCode >= 400) failedResource = true;
                    };
                    TaskCompletionSource<bool> loaded = new TaskCompletionSource<bool>();
                    printView.CoreWebView2.NavigationCompleted += delegate(object sender, CoreWebView2NavigationCompletedEventArgs args) { if (args.IsSuccess) loaded.TrySetResult(true); else if (args.WebErrorStatus != CoreWebView2WebErrorStatus.OperationCanceled) loaded.TrySetException(new IOException("打印页面无法加载。")); };
                    printView.Source = new Uri("https://print.paper.local/index.html");
                    await WithTimeout(loaded.Task, 15000);
                    Stopwatch timeout = Stopwatch.StartNew();
                    while (true)
                    {
                        stop.Token.ThrowIfCancellationRequested();
                        if (failedResource) throw new IOException("打印资源缺失，请完整解压程序文件夹后重试。");
                        string status = await printView.CoreWebView2.ExecuteScriptAsync("({ready:Boolean(window.__printReady) && (!document.fonts || document.fonts.status==='loaded') && Array.from(document.images).every(function(i){return i.complete && i.naturalWidth>0}),resourceError:Boolean(window.__nativePrintResourceError),error:typeof window.__printError==='string'?window.__printError.slice(0,300):''})");
                        Dictionary<string, object> ready = Program.Parse(status);
                        if (Program.Flag(ready, "resourceError")) throw new IOException("打印字体、样式或图片资源缺失，请完整解压程序后重试。");
                        if (!String.IsNullOrEmpty(Program.Text(ready, "error"))) throw new IOException("打印准备失败：" + Program.Text(ready, "error"));
                        if (Program.Flag(ready, "ready")) break;
                        if (timeout.ElapsedMilliseconds > 15000) throw new TimeoutException("打印字体或图片未能准备完成，请重试。");
                        await Task.Delay(100, stop.Token);
                    }
                    CoreWebView2PrintSettings settings = environment.CreatePrintSettings();
                    settings.ShouldPrintBackgrounds = true; settings.ShouldPrintHeaderAndFooter = false;
                    settings.PageWidth = 8.2677165; settings.PageHeight = 11.6929134;
                    settings.MarginTop = settings.MarginBottom = settings.MarginLeft = settings.MarginRight = 0;
                    Log("pdf-start", clock.ElapsedMilliseconds);
                    if (!await printView.CoreWebView2.PrintToPdfAsync(destination, settings)) throw new IOException("PDF 保存未完成，请重试。");
                    Log("pdf-complete", clock.ElapsedMilliseconds);
                    return new { cancelled = false, fileName = Path.GetFileName(destination), path = destination };
                }
            }
            finally
            {
                string safe = Path.GetFullPath(Path.Combine(Program.Data, "temp")) + Path.DirectorySeparatorChar + "print-";
                if (Path.GetFullPath(temporary).StartsWith(safe, StringComparison.OrdinalIgnoreCase) && Directory.Exists(temporary))
                    try { Directory.Delete(temporary, true); } catch { }
                printGate.Release();
            }
        }
        private static async Task WithTimeout(Task task, int timeout)
        {
            if (await Task.WhenAny(task, Task.Delay(timeout)) != task) throw new TimeoutException("页面准备超时。");
            await task;
        }

        private async Task EnsureWorkerAsync()
        {
            await workerGate.WaitAsync(stop.Token);
            try
            {
                if (worker != null && !worker.HasExited) return;
                if (worker != null) { job.Terminate(); if (workerInput != null) { try { workerInput.Dispose(); } catch { } workerInput = null; } worker.Dispose(); worker = null; }
                string executable = Path.Combine(Program.Root, "resources", "python", "python.exe");
                string service = Path.Combine(Program.Root, "worker", "service.py");
                if (!File.Exists(executable) || !File.Exists(service)) throw new FileNotFoundException("识别组件尚未准备好，仍可编辑、打开和保存工程。");
                ProcessStartInfo start = new ProcessStartInfo(executable, "-u \"" + service + "\"") {
                    WorkingDirectory = Program.Root, UseShellExecute = false, CreateNoWindow = true,
                    WindowStyle = ProcessWindowStyle.Hidden, RedirectStandardInput = true, RedirectStandardOutput = true,
                    RedirectStandardError = true, StandardOutputEncoding = Encoding.UTF8, StandardErrorEncoding = Encoding.UTF8
                };
                List<string> remove = new List<string>();
                foreach (string key in start.EnvironmentVariables.Keys)
                    if (key.StartsWith("OPENAI_", StringComparison.OrdinalIgnoreCase) || key.StartsWith("OPENROUTER_", StringComparison.OrdinalIgnoreCase) || key.StartsWith("VISION_", StringComparison.OrdinalIgnoreCase) || key == "PYTHONHOME" || key == "PYTHONPATH") remove.Add(key);
                foreach (string key in remove) start.EnvironmentVariables.Remove(key);
                start.EnvironmentVariables["PYTHONUTF8"] = "1"; start.EnvironmentVariables["PYTHONDONTWRITEBYTECODE"] = "1";
                start.EnvironmentVariables["PAPER_STUDIO_DATA_DIR"] = Program.Data;
                start.EnvironmentVariables["PAPER_STUDIO_RESOURCE_DIR"] = Path.Combine(Program.Root, "resources");
                start.EnvironmentVariables["TEMP"] = start.EnvironmentVariables["TMP"] = Path.Combine(Program.Data, "temp");
                start.EnvironmentVariables["XDG_CACHE_HOME"] = Path.Combine(Program.Data, "cache");
                Process process = new Process { StartInfo = start, EnableRaisingEvents = true };
                process.OutputDataReceived += WorkerOutput;
                process.ErrorDataReceived += delegate { /* No document or model output is persisted. */ };
                process.Exited += delegate { WorkerExited(process); };
                workerState = "starting"; WorkerState("starting", "正在后台准备识别服务。");
                try
                {
                    process.Start(); job.Assign(process); worker = process; workerStarted = true;
                    workerInput = new StreamWriter(process.StandardInput.BaseStream, new UTF8Encoding(false), 8192, true);
                    process.BeginOutputReadLine(); process.BeginErrorReadLine();
                }
                catch { try { if (!process.HasExited) process.Kill(); } catch { } process.Dispose(); throw; }
                Log("worker-start", clock.ElapsedMilliseconds);
            }
            catch (Exception error) { workerState = "error"; WorkerState("error", error.Message); throw; }
            finally { workerGate.Release(); }
        }

        private async Task ForwardWorkerAsync(string id, Dictionary<string, object> payload)
        {
            string method = Program.Text(payload, "method"); object parameters;
            if (method == null || !WorkerMethods.Contains(method) || !payload.TryGetValue("params", out parameters) || !(parameters is Dictionary<string, object>)) throw new InvalidDataException("识别操作无效。");
            await EnsureWorkerAsync();
            string line = Program.Json(new { id = id, method = method, @params = parameters });
            if (line.Length > Program.MaxJson) throw new InvalidDataException("识别请求过大。");
            lock (pendingLock) { if (pending.Count >= 64 || !pending.Add(id)) throw new InvalidDataException("请求过多或标识重复。"); }
            await writeGate.WaitAsync(stop.Token);
            try { await workerInput.WriteLineAsync(line); await workerInput.FlushAsync(); }
            catch { lock (pendingLock) pending.Remove(id); throw; }
            finally { writeGate.Release(); }
        }
        private void WorkerOutput(object sender, DataReceivedEventArgs args)
        {
            if (args.Data == null || closing || !Object.ReferenceEquals(sender, worker)) return;
            try
            {
                if (args.Data.Length > Program.MaxJson) throw new InvalidDataException();
                Dictionary<string, object> value = Program.Parse(args.Data);
                string type = Program.Text(value, "type");
                if (type == "response")
                {
                    string id = Program.Text(value, "id");
                    lock (pendingLock) { if (id == null || !pending.Remove(id)) return; }
                }
                else if (type == "event")
                {
                    string name = Program.Text(value, "event");
                    if (name == null || !Regex.IsMatch(name, @"\A[a-z][a-z0-9-]{0,63}\z")) return;
                    if (name == "worker-state") workerState = Program.Text(value, "state") ?? workerState;
                }
                else return;
                Post(value);
            }
            catch { WorkerState("error", "识别服务返回了无效消息，可以重试。"); }
        }
        private void WorkerExited(Process process)
        {
            workerGate.Wait();
            try
            {
                if (closing || !Object.ReferenceEquals(process, worker)) return;
                job.Terminate();
                workerState = "error"; WorkerState("error", "识别服务已停止，可以重试；工程内容仍保留。");
                string[] ids;
                lock (pendingLock) { ids = new List<string>(pending).ToArray(); pending.Clear(); }
                foreach (string id in ids) Reply(id, false, null, "识别服务已停止，请重试。");
                Log("worker-exit", clock.ElapsedMilliseconds);
            }
            finally { workerGate.Release(); }
        }
        private void WorkerState(string state, string message) { Post(new { type = "event", @event = "worker-state", state = state, message = message }); }
        private void Reply(string id, bool ok, object result, string message) { Post(new { type = "response", id = id, ok = ok, result = result, error = message == null ? null : new { code = "NATIVE_REQUEST_FAILED", message = message } }); }
        private void Post(object value)
        {
            if (closing || IsDisposed || !IsHandleCreated) return;
            string json = Program.Json(value);
            try { BeginInvoke(new Action(delegate { if (!closing && view.CoreWebView2 != null) view.CoreWebView2.PostWebMessageAsJson(json); })); }
            catch (InvalidOperationException) { }
        }
        private void FailStartup(string message)
        {
            if (closing) return;
            loading.Text = message;
            if (startupTest) { Program.WriteResult(resultPath, new { passed = false, error = message, elapsedMs = clock.ElapsedMilliseconds, workerStarted = workerStarted }); BeginInvoke(new Action(Close)); }
        }
        private void Log(string name, long elapsed)
        {
            try
            {
                lock (logLock)
                {
                    string folder = Path.Combine(Program.Data, "logs"); Directory.CreateDirectory(folder);
                    string filename = Path.Combine(folder, "native.log");
                    if (File.Exists(filename) && new FileInfo(filename).Length > 256 * 1024) File.WriteAllText(filename, "");
                    File.AppendAllText(filename, Program.Json(new { time = DateTime.UtcNow.ToString("o"), @event = name, elapsedMs = elapsed }) + "\n", new UTF8Encoding(false));
                }
            }
            catch { }
        }
    }

    internal sealed class Job : IDisposable
    {
        private IntPtr handle;
        internal Job()
        {
            handle = CreateJobObject(IntPtr.Zero, null);
            if (handle == IntPtr.Zero) throw new System.ComponentModel.Win32Exception();
            ExtendedLimits limits = new ExtendedLimits(); limits.BasicLimitInformation.LimitFlags = 0x2000;
            int length = Marshal.SizeOf(typeof(ExtendedLimits)); IntPtr memory = Marshal.AllocHGlobal(length);
            try
            {
                Marshal.StructureToPtr(limits, memory, false);
                if (!SetInformationJobObject(handle, 9, memory, (uint)length)) throw new System.ComponentModel.Win32Exception();
            }
            catch { Dispose(); throw; }
            finally { Marshal.FreeHGlobal(memory); }
        }
        internal void Assign(Process process) { if (!AssignProcessToJobObject(handle, process.Handle)) throw new System.ComponentModel.Win32Exception(); }
        internal void Terminate() { IntPtr owned = Interlocked.CompareExchange(ref handle, IntPtr.Zero, IntPtr.Zero); if (owned != IntPtr.Zero) TerminateJobObject(owned, 1); }
        public void Dispose() { IntPtr owned = Interlocked.Exchange(ref handle, IntPtr.Zero); if (owned != IntPtr.Zero) CloseHandle(owned); }
        [StructLayout(LayoutKind.Sequential)] private struct BasicLimits { public long PerProcessUserTimeLimit, PerJobUserTimeLimit; public uint LimitFlags; public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize; public uint ActiveProcessLimit; public UIntPtr Affinity; public uint PriorityClass, SchedulingClass; }
        [StructLayout(LayoutKind.Sequential)] private struct IoCounters { public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount, ReadTransferCount, WriteTransferCount, OtherTransferCount; }
        [StructLayout(LayoutKind.Sequential)] private struct ExtendedLimits { public BasicLimits BasicLimitInformation; public IoCounters IoInfo; public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed; }
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern IntPtr CreateJobObject(IntPtr attributes, string name);
        [DllImport("kernel32.dll", SetLastError = true)] private static extern bool SetInformationJobObject(IntPtr job, int information, IntPtr value, uint length);
        [DllImport("kernel32.dll", SetLastError = true)] private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
        [DllImport("kernel32.dll", SetLastError = true)] private static extern bool TerminateJobObject(IntPtr job, uint exitCode);
        [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr handle);
    }
}
