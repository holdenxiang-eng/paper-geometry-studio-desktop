using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Globalization;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Net;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Win32;

namespace ScreenshotInstaller
{
    internal sealed class Part
    {
        internal string Name, Hash;
        internal long Bytes;
        internal Uri Url;
    }

    internal sealed class Payload
    {
        internal string Product, Name, Hash;
        internal long Bytes;
        internal readonly List<Part> Parts = new List<Part>();
        internal static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 1024 * 1024, RecursionLimit = 20 };
        internal static string Resource(string name)
        {
            using (Stream stream = Assembly.GetExecutingAssembly().GetManifestResourceStream(name))
            {
                if (stream == null) throw new InvalidDataException("安装信息缺失，请重新下载安装程序。");
                using (StreamReader reader = new StreamReader(stream, Encoding.UTF8)) return reader.ReadToEnd();
            }
        }
        internal static string Text(Dictionary<string, object> value, string key)
        {
            object result;
            return value.TryGetValue(key, out result) && result is string ? (string)result : "";
        }
        internal static long Number(Dictionary<string, object> value, string key)
        {
            object item; long result;
            if (!value.TryGetValue(key, out item) || item is bool || !Int64.TryParse(Convert.ToString(item, CultureInfo.InvariantCulture), out result))
                throw new InvalidDataException("安装包长度无效。");
            return result;
        }
        internal static bool SafeName(string value)
        {
            return !String.IsNullOrWhiteSpace(value) && value.Length <= 150 && value == Path.GetFileName(value)
                && value.IndexOfAny(Path.GetInvalidFileNameChars()) < 0 && !value.EndsWith(".") && !value.EndsWith(" ")
                && !Regex.IsMatch(value, @"^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)", RegexOptions.IgnoreCase);
        }
        private static string HashValue(Dictionary<string, object> value)
        {
            string result = Text(value, "sha256").ToLowerInvariant();
            if (!Regex.IsMatch(result, "^[a-f0-9]{64}$")) throw new InvalidDataException("安装校验信息无效。");
            return result;
        }
        internal static Payload Parse(string source)
        {
            Dictionary<string, object> root = Json.DeserializeObject(source) as Dictionary<string, object>;
            object windows, rawParts, rawPackage;
            if (root == null || Number(root, "schema") != 1 || String.IsNullOrWhiteSpace(Text(root, "product"))
                || !root.TryGetValue("supportedWindows64", out windows) || !(windows is bool) || !(bool)windows
                || !root.TryGetValue("package", out rawPackage) || !(rawPackage is Dictionary<string, object>)
                || !root.TryGetValue("parts", out rawParts) || !(rawParts is object[]))
                throw new InvalidDataException("安装清单格式无效。");
            string repository = Resource("installer-repository.txt").Trim();
            if (!Regex.IsMatch(repository, @"^holdenxiang-eng/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$"))
                throw new InvalidDataException("安装程序的发布仓库无效。");
            Dictionary<string, object> package = (Dictionary<string, object>)rawPackage;
            Payload result = new Payload { Product = Text(root, "product"), Name = Text(package, "fileName"), Bytes = Number(package, "bytes"), Hash = HashValue(package) };
            if (!SafeName(result.Name) || !result.Name.EndsWith(".zip", StringComparison.OrdinalIgnoreCase) || result.Bytes <= 0 || result.Bytes > 16L * 1024 * 1024 * 1024)
                throw new InvalidDataException("完整安装包信息无效。");
            HashSet<string> names = new HashSet<string>(StringComparer.OrdinalIgnoreCase); long total = 0; string release = null;
            foreach (object item in (object[])rawParts)
            {
                Dictionary<string, object> value = item as Dictionary<string, object>;
                if (value == null) throw new InvalidDataException("数据分卷信息无效。");
                Part part = new Part { Name = Text(value, "fileName"), Bytes = Number(value, "bytes"), Hash = HashValue(value) };
                Uri url;
                if (!SafeName(part.Name) || part.Name.Equals(result.Name, StringComparison.OrdinalIgnoreCase) || !names.Add(part.Name)
                    || part.Name.Equals(".cache-owner", StringComparison.OrdinalIgnoreCase) || part.Name.Equals("install.lock", StringComparison.OrdinalIgnoreCase) || part.Name.EndsWith(".download", StringComparison.OrdinalIgnoreCase)
                    || part.Bytes <= 0 || part.Bytes >= 2L * 1024 * 1024 * 1024
                    || !Uri.TryCreate(Text(value, "url"), UriKind.Absolute, out url) || !GithubUrl(url, repository))
                    throw new InvalidDataException("数据分卷地址或长度无效。");
                string[] segments = url.AbsolutePath.Split('/');
                if (Uri.UnescapeDataString(segments[6]) != part.Name) throw new InvalidDataException("数据分卷文件名与下载地址不符。");
                string tag = Uri.UnescapeDataString(segments[5]);
                if (release != null && release != tag) throw new InvalidDataException("数据分卷不属于同一版本。");
                release = tag; part.Url = url; total = checked(total + part.Bytes); result.Parts.Add(part);
            }
            if (result.Parts.Count < 1 || result.Parts.Count > 16 || total != result.Bytes)
                throw new InvalidDataException("数据分卷总长度不符。");
            return result;
        }
        internal static bool GithubUrl(Uri url, string repository)
        {
            if (url.Scheme != "https" || !url.Host.Equals("github.com", StringComparison.OrdinalIgnoreCase) || !url.IsDefaultPort
                || url.UserInfo.Length != 0 || url.Query.Length != 0 || url.Fragment.Length != 0) return false;
            string[] parts = url.AbsolutePath.Split('/');
            if (parts.Length != 7 || parts[1] + "/" + parts[2] != repository || parts[3] != "releases" || parts[4] != "download") return false;
            return parts.Skip(1).All(value => { string decoded = Uri.UnescapeDataString(value); return decoded.Length > 0 && decoded != "." && decoded != ".." && decoded.IndexOfAny(new[] { '/', '\\', '\0' }) < 0; });
        }
    }

    internal sealed class InstallProgress
    {
        internal string Message;
        internal long Done, Total;
        internal InstallProgress(string message, long done, long total) { Message = message; Done = done; Total = total; }
    }

    // ZipArchive can seek across the verified release parts. No second 3 GB ZIP
    // copy is materialized, and the application never uses this stream at startup.
    internal sealed class PartsStream : Stream
    {
        private readonly FileStream[] files;
        private readonly long[] starts;
        private readonly CancellationToken cancel;
        private long position, length;
        internal PartsStream(IEnumerable<string> paths, CancellationToken token)
        {
            cancel = token; List<FileStream> opened = new List<FileStream>(); List<long> offsets = new List<long>();
            try { foreach (string path in paths) { offsets.Add(length); FileStream file = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read); opened.Add(file); length += file.Length; } }
            catch { foreach (FileStream file in opened) file.Dispose(); throw; }
            files = opened.ToArray(); starts = offsets.ToArray();
        }
        public override bool CanRead { get { return true; } } public override bool CanSeek { get { return true; } } public override bool CanWrite { get { return false; } }
        public override long Length { get { return length; } } public override long Position { get { return position; } set { Seek(value, SeekOrigin.Begin); } }
        public override int Read(byte[] buffer, int offset, int count)
        {
            cancel.ThrowIfCancellationRequested(); int total = 0;
            while (count > 0 && position < length)
            {
                int index = starts.Length - 1; while (index > 0 && starts[index] > position) index--;
                FileStream file = files[index]; long local = position - starts[index]; file.Position = local;
                int read = file.Read(buffer, offset, (int)Math.Min(count, file.Length - local));
                if (read == 0) throw new EndOfStreamException("数据分卷不完整。");
                position += read; total += read; offset += read; count -= read; cancel.ThrowIfCancellationRequested();
            }
            return total;
        }
        public override long Seek(long offset, SeekOrigin origin)
        {
            long next = checked((origin == SeekOrigin.Begin ? 0 : origin == SeekOrigin.Current ? position : length) + offset);
            if (next < 0 || next > length) throw new IOException("安装包偏移无效。"); position = next; return position;
        }
        public override void Flush() { } public override void SetLength(long value) { throw new NotSupportedException(); }
        public override void Write(byte[] buffer, int offset, int count) { throw new NotSupportedException(); }
        protected override void Dispose(bool disposing) { if (disposing) foreach (FileStream file in files) file.Dispose(); base.Dispose(disposing); }
    }

    internal static class InstallCore
    {
        internal const string Entry = "截图组卷.exe", Marker = ".screenshot-studio-install.json";
        private static readonly string[] Required = { Entry, "Microsoft.Web.WebView2.Core.dll", "Microsoft.Web.WebView2.WinForms.dll", "WebView2Loader.dll", "native-manifest.json", "ui/index.html", "worker/service.py", "resources/python/python.exe", "resources/python/python312.dll", "resources/vision/llama/llama-server.exe", "resources/vision/Qwen3VL-4B-Instruct-Q4_K_M.gguf", "resources/vision/mmproj-Qwen3VL-4B-Instruct-Q8_0.gguf", "resources/python/Lib/site-packages/rapidocr/models/PP-OCRv6_det_small.onnx", "resources/python/Lib/site-packages/rapidocr/models/PP-OCRv6_rec_small.onnx", "resources/python/Lib/site-packages/rapidocr/models/ch_ppocr_mobile_v2.0_cls_mobile.onnx" };
        private static readonly HashSet<string> RootFiles = new HashSet<string>(new[] { Entry, "Microsoft.Web.WebView2.Core.dll", "Microsoft.Web.WebView2.WinForms.dll", "WebView2Loader.dll", "native-manifest.json", "README.md", "README.txt", "使用说明.txt", Marker }, StringComparer.OrdinalIgnoreCase);
        private static readonly HashSet<string> RootDirectories = new HashSet<string>(new[] { "ui", "worker", "resources", "licenses" }, StringComparer.OrdinalIgnoreCase);
        private static string Sha(Stream source, CancellationToken cancel, Action<long> progress)
        {
            using (SHA256 hash = SHA256.Create()) { byte[] block = new byte[1024 * 1024]; int read; long total = 0;
                while ((read = source.Read(block, 0, block.Length)) != 0) { cancel.ThrowIfCancellationRequested(); hash.TransformBlock(block, 0, read, null, 0); total += read; if (progress != null) progress(total); }
                hash.TransformFinalBlock(new byte[0], 0, 0); return BitConverter.ToString(hash.Hash).Replace("-", "").ToLowerInvariant(); }
        }
        internal static string FileHash(string file, CancellationToken cancel) { using (FileStream input = File.OpenRead(file)) return Sha(input, cancel, null); }
        private static bool Verified(string path, long bytes, string hash, CancellationToken cancel)
        {
            return File.Exists(path) && new FileInfo(path).Length == bytes && FileHash(path, cancel) == hash;
        }
        private static string Full(string path) { string full = Path.GetFullPath(path); return full.Equals(Path.GetPathRoot(full), StringComparison.OrdinalIgnoreCase) ? full : full.TrimEnd(Path.DirectorySeparatorChar); }
        private static void NoLinks(string path)
        {
            for (string current = path; !String.IsNullOrEmpty(current); current = Path.GetDirectoryName(current))
                if ((Directory.Exists(current) || File.Exists(current)) && (File.GetAttributes(current) & FileAttributes.ReparsePoint) != 0)
                    throw new IOException("安装位置包含目录链接，请选择普通文件夹。");
        }
        private static void NoLinksTree(string root)
        {
            NoLinks(root); foreach (string item in Directory.EnumerateFileSystemEntries(root)) { if ((File.GetAttributes(item) & FileAttributes.ReparsePoint) != 0) throw new IOException("安装目录包含链接，已停止以保留现有文件。"); if (Directory.Exists(item)) NoLinksTree(item); }
        }
        private static void DeleteOwned(string path, string parent, string prefix)
        {
            if (!Directory.Exists(path)) return;
            if (!String.Equals(Path.GetDirectoryName(Full(path)), Full(parent), StringComparison.OrdinalIgnoreCase) || !Path.GetFileName(path).StartsWith(prefix, StringComparison.Ordinal))
                throw new IOException("临时目录边界无效。");
            NoLinksTree(path); Directory.Delete(path, true);
        }
        private static void ValidateLayout(string path)
        {
            foreach (string name in Required) if (!File.Exists(Path.Combine(path, name)) || new FileInfo(Path.Combine(path, name)).Length == 0) throw new InvalidDataException("安装包缺少必要文件：" + name);
            Dictionary<string, object> manifest = Payload.Json.DeserializeObject(File.ReadAllText(Path.Combine(path, "native-manifest.json"), Encoding.UTF8)) as Dictionary<string, object>;
            object files, expected;
            if (manifest == null || Payload.Text(manifest, "launcher") != Entry || !manifest.TryGetValue("files", out files) || !(files is Dictionary<string, object>)
                || !((Dictionary<string, object>)files).TryGetValue(Entry, out expected) || Convert.ToString(expected) != FileHash(Path.Combine(path, Entry), CancellationToken.None))
                throw new InvalidDataException("程序入口校验失败，请重新下载。");
        }
        private static void ExistingTarget(string target)
        {
            if (!Directory.Exists(target)) return; NoLinksTree(target);
            if (!Directory.EnumerateFileSystemEntries(target).Any()) return;
            ValidateLayout(target);
            foreach (string item in Directory.EnumerateFileSystemEntries(target))
            {
                string name = Path.GetFileName(item);
                if (Directory.Exists(item) ? !(RootDirectories.Contains(name) || name.Equals("data", StringComparison.OrdinalIgnoreCase))
                    : !(RootFiles.Contains(name) || name.EndsWith(".paper.json", StringComparison.OrdinalIgnoreCase)))
                    throw new IOException("安装位置还有其他文件，请选择新的空文件夹以保留它们。");
            }
        }
        [DllImport("kernel32.dll", SetLastError = true)] private static extern IntPtr OpenProcess(int access, bool inherit, int id);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool QueryFullProcessImageName(IntPtr process, int flags, StringBuilder path, ref int length);
        [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr handle);
        private static void NotRunning(string target)
        {
            foreach (Process process in Process.GetProcesses()) using (process)
            {
                IntPtr handle = OpenProcess(0x1000, false, process.Id); if (handle == IntPtr.Zero) continue;
                try { int size = 32768; StringBuilder path = new StringBuilder(size); if (QueryFullProcessImageName(handle, 0, path, ref size) && path.ToString().StartsWith(target + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)) throw new IOException("程序正在运行，请先保存工程并退出，再继续安装。"); }
                finally { CloseHandle(handle); }
            }
        }
        private static bool RedirectAllowed(Uri uri)
        {
            string repository = Payload.Resource("installer-repository.txt").Trim();
            return Payload.GithubUrl(uri, repository) || (uri.Scheme == "https" && uri.IsDefaultPort && uri.UserInfo.Length == 0 && uri.Fragment.Length == 0
                && new[] { "release-assets.githubusercontent.com", "objects.githubusercontent.com", "github-releases.githubusercontent.com" }.Contains(uri.Host.ToLowerInvariant()));
        }
        private static void Download(Part part, string destination, long prefix, long total, CancellationToken cancel, Action<InstallProgress> report)
        {
            try
            {
            string partial = destination + ".download"; NoLinks(partial); long offset = File.Exists(partial) ? new FileInfo(partial).Length : 0;
            if (offset > part.Bytes) { File.Delete(partial); offset = 0; }
            if (offset == part.Bytes)
            {
                if (Verified(partial, part.Bytes, part.Hash, cancel)) { if (File.Exists(destination)) File.Delete(destination); File.Move(partial, destination); report(new InstallProgress("数据分卷已完成校验", prefix + part.Bytes, total)); return; }
                File.Delete(partial); offset = 0;
            }
            Uri url = part.Url;
            for (int redirect = 0; redirect < 6; redirect++)
            {
                cancel.ThrowIfCancellationRequested(); HttpWebRequest request = (HttpWebRequest)WebRequest.Create(url);
                request.AllowAutoRedirect = false; request.Timeout = 30000; request.ReadWriteTimeout = 30000; request.UserAgent = "ScreenshotStudio-Installer/1";
                if (offset > 0) request.AddRange(offset);
                using (cancel.Register(request.Abort))
                {
                    HttpWebResponse response;
                    try { response = (HttpWebResponse)request.GetResponse(); } catch (WebException) { cancel.ThrowIfCancellationRequested(); throw; }
                    using (response)
                    {
                        int code = (int)response.StatusCode;
                        if (code >= 300 && code < 400) { Uri next; if (!Uri.TryCreate(url, response.Headers["Location"], out next) || !RedirectAllowed(next)) throw new IOException("下载跳转地址无效。"); url = next; continue; }
                        if (code != 200 && code != 206) throw new IOException("GitHub 下载暂时不可用，请稍后重试。");
                        if (code == 200) offset = 0;
                        else if (!(response.Headers["Content-Range"] ?? "").StartsWith("bytes " + offset.ToString(CultureInfo.InvariantCulture) + "-", StringComparison.Ordinal)) throw new IOException("下载续传范围无效。");
                        using (Stream input = response.GetResponseStream()) using (FileStream output = new FileStream(partial, offset == 0 ? FileMode.Create : FileMode.Append, FileAccess.Write, FileShare.None))
                        {
                            byte[] buffer = new byte[128 * 1024]; int read; long current = offset; Stopwatch clock = Stopwatch.StartNew();
                            while ((read = input.Read(buffer, 0, buffer.Length)) != 0) { cancel.ThrowIfCancellationRequested(); current += read; if (current > part.Bytes) throw new IOException("下载长度超过安装清单。"); output.Write(buffer, 0, read); if (clock.ElapsedMilliseconds >= 100) { report(new InstallProgress("正在下载 " + part.Name, prefix + current, total)); clock.Restart(); } }
                            if (current != part.Bytes) throw new IOException("下载未完成，已保留进度，重试可以继续。");
                        }
                    }
                }
                if (!Verified(partial, part.Bytes, part.Hash, cancel)) { File.Delete(partial); throw new IOException("下载校验失败，请重试。"); }
                if (File.Exists(destination)) File.Delete(destination); File.Move(partial, destination); report(new InstallProgress("数据分卷已完成校验", prefix + part.Bytes, total)); return;
            }
            throw new IOException("下载跳转次数过多，请稍后重试。");
            }
            catch { cancel.ThrowIfCancellationRequested(); throw; }
        }
        private static void Extract(Payload payload, Stream input, string stage, CancellationToken cancel, Action<InstallProgress> report)
        {
            HashSet<string> names = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            using (ZipArchive zip = new ZipArchive(input, ZipArchiveMode.Read, true))
            {
                if (zip.Entries.Count > 50000) throw new InvalidDataException("安装包文件数量无效。");
                long total = 0; foreach (ZipArchiveEntry entry in zip.Entries) { total = checked(total + entry.Length); if (total > 16L * 1024 * 1024 * 1024) throw new InvalidDataException("安装包解压长度无效。"); }
                DriveInfo drive = new DriveInfo(Path.GetPathRoot(stage)); if (drive.AvailableFreeSpace < total + 64 * 1024 * 1024) throw new IOException("安装盘可用空间不足，请选择有足够空间的文件夹。");
                report(new InstallProgress("正在准备程序文件", 0, total));
                long done = 0; Stopwatch clock = Stopwatch.StartNew();
                foreach (ZipArchiveEntry entry in zip.Entries)
                {
                    cancel.ThrowIfCancellationRequested(); string name = entry.FullName.Replace('\\', '/');
                    if (!name.StartsWith("截图组卷/", StringComparison.Ordinal) || (entry.ExternalAttributes >> 16 & 0xF000) == 0xA000 || (entry.ExternalAttributes & 0x400) != 0) throw new InvalidDataException("安装包包含无效路径或链接。");
                    string relative = name.Substring("截图组卷/".Length).TrimEnd('/'); if (relative.Length == 0) continue;
                    string[] pieces = relative.Split('/');
                    if (pieces.Any(value => !Payload.SafeName(value)) || pieces[0].Equals("data", StringComparison.OrdinalIgnoreCase)
                        || !(RootDirectories.Contains(pieces[0]) || (pieces.Length == 1 && RootFiles.Contains(pieces[0]) && pieces[0] != Marker)) || !names.Add(relative))
                        throw new InvalidDataException("安装包路径无效或覆盖用户数据。");
                    string destination = Path.GetFullPath(Path.Combine(stage, relative)); if (!destination.StartsWith(stage + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)) throw new InvalidDataException("解压路径越界。");
                    if (name.EndsWith("/")) { Directory.CreateDirectory(destination); continue; }
                    Directory.CreateDirectory(Path.GetDirectoryName(destination));
                    using (Stream source = entry.Open()) using (FileStream output = new FileStream(destination, FileMode.CreateNew, FileAccess.Write, FileShare.None))
                    { byte[] buffer = new byte[128 * 1024]; int read; long length = 0; while ((read = source.Read(buffer, 0, buffer.Length)) != 0) { cancel.ThrowIfCancellationRequested(); length += read; done += read; if (length > entry.Length) throw new InvalidDataException("安装包文件长度无效。"); output.Write(buffer, 0, read); if (clock.ElapsedMilliseconds >= 100) { report(new InstallProgress("正在准备程序文件", done, total)); clock.Restart(); } } if (length != entry.Length) throw new InvalidDataException("安装包文件不完整。"); }
                }
            }
        }
        internal static string Run(Payload payload, string destination, CancellationToken cancel, Action<InstallProgress> report, string localParts)
        {
            if (String.IsNullOrWhiteSpace(destination) || !Regex.IsMatch(destination, @"^[A-Za-z]:[\\/]")) throw new IOException("请选择本机磁盘上的完整安装路径。");
            string target = Full(destination), parent = Path.GetDirectoryName(target), leaf = Path.GetFileName(target);
            if (parent == null || !Payload.SafeName(leaf) || target.Equals(Full(AppDomain.CurrentDomain.BaseDirectory), StringComparison.OrdinalIgnoreCase)) throw new IOException("请选择安装器之外的普通程序文件夹。");
            if (File.Exists(target)) throw new IOException("安装位置是一个文件，请选择普通文件夹。");
            NoLinks(target); Directory.CreateDirectory(parent); NotRunning(target); ExistingTarget(target); cancel.ThrowIfCancellationRequested();
            string marker = Path.Combine(target, Marker);
            if (File.Exists(marker)) { Dictionary<string, object> current = Payload.Json.DeserializeObject(File.ReadAllText(marker, Encoding.UTF8)) as Dictionary<string, object>; if (current != null && Payload.Text(current, "sha256") == payload.Hash) { ValidateLayout(target); report(new InstallProgress("程序已安装，可以直接打开", payload.Bytes, payload.Bytes)); return target; } }
            string cache = target + ".install-cache", prefix = "." + leaf + ".install-", stage = Path.Combine(parent, prefix + "stage-" + Guid.NewGuid().ToString("N"));
            bool retainStage = false;
            string owner = Path.Combine(cache, ".cache-owner"), identity = "ScreenshotStudio\n" + target;
            NoLinks(cache); Directory.CreateDirectory(cache); NoLinksTree(cache);
            if (File.Exists(owner) ? File.ReadAllText(owner, Encoding.UTF8) != identity : Directory.EnumerateFileSystemEntries(cache).Any()) throw new IOException("安装缓存目录已被其他文件占用，请选择新位置。");
            File.WriteAllText(owner, identity, new UTF8Encoding(false));
            try
            {
                using (FileStream installLock = new FileStream(Path.Combine(cache, "install.lock"), FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None))
                {
                    long completed = 0; List<string> paths = new List<string>();
                    foreach (Part part in payload.Parts)
                    {
                        cancel.ThrowIfCancellationRequested(); string path = Path.Combine(cache, part.Name); NoLinks(path);
                        report(new InstallProgress("检查数据分卷 " + part.Name, completed, payload.Bytes));
                        if (!Verified(path, part.Bytes, part.Hash, cancel))
                        {
                            if (localParts != null) { string original = Path.Combine(Full(localParts), part.Name); NoLinks(original); if (!Verified(original, part.Bytes, part.Hash, cancel)) throw new InvalidDataException("本地数据分卷校验失败。"); File.Copy(original, path, true); }
                            else Download(part, path, completed, payload.Bytes, cancel, report);
                        }
                        paths.Add(path); completed += part.Bytes;
                    }
                    Directory.CreateDirectory(stage);
                    using (PartsStream joined = new PartsStream(paths, cancel))
                    {
                        Stopwatch clock = Stopwatch.StartNew();
                        if (joined.Length != payload.Bytes || Sha(joined, cancel, delegate(long done) { if (clock.ElapsedMilliseconds >= 100) { report(new InstallProgress("校验完整安装包", done, payload.Bytes)); clock.Restart(); } }) != payload.Hash) throw new InvalidDataException("完整安装包校验失败。");
                        joined.Position = 0; Extract(payload, joined, stage, cancel, report);
                    }
                    ValidateLayout(stage); File.WriteAllText(Path.Combine(stage, Marker), Payload.Json.Serialize(new { schema = 1, product = payload.Product, sha256 = payload.Hash }), new UTF8Encoding(false));
                    cancel.ThrowIfCancellationRequested(); NotRunning(target); ExistingTarget(target);
                    string backup = Path.Combine(parent, prefix + "backup-" + Guid.NewGuid().ToString("N")); List<string> preserved = new List<string>(); bool moved = false;
                    try
                    {
                        if (Directory.Exists(target))
                        {
                            Directory.Move(target, backup); moved = true;
                            foreach (string item in Directory.EnumerateFileSystemEntries(backup).Where(value => Path.GetFileName(value).Equals("data", StringComparison.OrdinalIgnoreCase) || value.EndsWith(".paper.json", StringComparison.OrdinalIgnoreCase)).ToArray())
                            { string name = Path.GetFileName(item); if (Directory.Exists(item)) Directory.Move(item, Path.Combine(stage, name)); else File.Move(item, Path.Combine(stage, name)); preserved.Add(name); }
                        }
                        Directory.Move(stage, target);
                    }
                    catch
                    {
                        try { foreach (string name in preserved.AsEnumerable().Reverse()) { string item = Path.Combine(stage, name); if (Directory.Exists(item)) Directory.Move(item, Path.Combine(backup, name)); else if (File.Exists(item)) File.Move(item, Path.Combine(backup, name)); } if (moved && !Directory.Exists(target)) Directory.Move(backup, target); }
                        catch (Exception rollback) { retainStage = true; throw new IOException("安装未完成，原文件保留在 " + backup + " 和 " + stage + "。请勿删除这两个目录。", rollback); }
                        throw;
                    }
                    if (moved) { try { DeleteOwned(backup, parent, prefix + "backup-"); } catch { /* Installed files and preserved data remain usable. */ } }
                }
                try { NoLinksTree(cache); Directory.Delete(cache, true); } catch { /* Verified cache can be removed after a successful install. */ }
                report(new InstallProgress("安装完成", payload.Bytes, payload.Bytes)); return target;
            }
            finally { if (!retainStage) try { DeleteOwned(stage, parent, prefix + "stage-"); } catch { /* Never follow an unexpected link during cleanup. */ } }
        }
        internal static bool HasWebView2()
        {
            const string key = @"Software\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}";
            foreach (RegistryHive hive in new[] { RegistryHive.LocalMachine, RegistryHive.CurrentUser })
                foreach (RegistryView view in new[] { RegistryView.Registry32, RegistryView.Registry64 })
                    try { using (RegistryKey root = RegistryKey.OpenBaseKey(hive, view)) using (RegistryKey item = root.OpenSubKey(key)) { Version version; if (item != null && Version.TryParse(Convert.ToString(item.GetValue("pv")), out version) && version > new Version(0, 0, 0, 0)) return true; } } catch { }
            return false;
        }
    }

    internal sealed class InstallerWindow : Form
    {
        private readonly Payload payload;
        private readonly TextBox target = new TextBox();
        private readonly Button browse = new Button(), install = new Button(), cancel = new Button();
        private readonly Label state = new Label(), detail = new Label();
        private readonly ProgressBar progress = new ProgressBar();
        private CancellationTokenSource cancellation; private bool busy, closeRequested;
        internal InstallerWindow(Payload value)
        {
            payload = value; Text = "安装截图组卷"; ClientSize = new Size(620, 330); MinimumSize = Size; MaximizeBox = false; StartPosition = FormStartPosition.CenterScreen; Font = new Font("Microsoft YaHei UI", 10); BackColor = Color.White;
            Label heading = new Label { Text = "截图组卷", Font = new Font(Font.FontFamily, 20, FontStyle.Bold), AutoSize = true, Location = new Point(24, 22) };
            Label intro = new Label { Text = "首次安装下载约 " + SizeText(payload.Bytes) + "。完成后可离线使用，无需账号或密钥。", AutoSize = false, Size = new Size(570, 48), Location = new Point(25, 72) };
            target.SetBounds(25, 124, 470, 30); target.Text = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "截图组卷");
            browse.Text = "选择位置"; browse.SetBounds(505, 123, 90, 31); browse.Click += delegate { using (FolderBrowserDialog dialog = new FolderBrowserDialog { Description = "选择有写入权限的安装位置，建议使用 D 盘。", SelectedPath = Directory.Exists(target.Text) ? target.Text : AppDomain.CurrentDomain.BaseDirectory }) { if (dialog.ShowDialog(this) == DialogResult.OK) target.Text = Path.GetFileName(dialog.SelectedPath) == "截图组卷" ? dialog.SelectedPath : Path.Combine(dialog.SelectedPath, "截图组卷"); } };
            state.SetBounds(25, 174, 570, 24); state.Text = "仅支持 Windows 10/11 64 位并已具备 WebView2 的电脑。";
            progress.SetBounds(25, 205, 570, 16); progress.Maximum = 1000; detail.SetBounds(25, 228, 570, 28);
            install.Text = "安装并打开"; install.SetBounds(365, 278, 140, 34); install.Click += StartInstall;
            cancel.Text = "取消"; cancel.SetBounds(515, 278, 80, 34); cancel.Click += delegate { if (busy) { cancellation.Cancel(); state.Text = "正在取消，已下载的数据将保留供重试。"; } else Close(); };
            Controls.AddRange(new Control[] { heading, intro, target, browse, state, progress, detail, install, cancel });
            FormClosing += delegate(object sender, FormClosingEventArgs args) { if (busy) { closeRequested = true; cancellation.Cancel(); args.Cancel = true; } };
        }
        private static string SizeText(long bytes) { return bytes >= 1000000000 ? (bytes / 1000000000d).ToString("0.0") + " GB" : (bytes / 1000000d).ToString("0.0") + " MB"; }
        private async void StartInstall(object sender, EventArgs args)
        {
            if (busy) return;
            if (!Environment.Is64BitOperatingSystem || Environment.OSVersion.Version.Major < 10 || !InstallCore.HasWebView2()) { MessageBox.Show(this, "请使用已具备 WebView2 的 Windows 10/11 64 位电脑。此安装器不会安装系统组件。", "当前电脑不受支持", MessageBoxButtons.OK, MessageBoxIcon.Information); return; }
            busy = true; closeRequested = false; install.Enabled = browse.Enabled = target.Enabled = false; cancellation = new CancellationTokenSource(); bool opened = false;
            try
            {
                string location = target.Text;
                Progress<InstallProgress> updates = new Progress<InstallProgress>(value => { if (IsDisposed) return; state.Text = value.Message; detail.Text = SizeText(value.Done) + " / " + SizeText(value.Total) + "，剩余 " + SizeText(Math.Max(0, value.Total - value.Done)); progress.Value = value.Total <= 0 ? 0 : Math.Max(0, Math.Min(1000, (int)(value.Done * 1000d / value.Total))); });
                string installed = await Task.Run(() => InstallCore.Run(payload, location, cancellation.Token, value => ((IProgress<InstallProgress>)updates).Report(value), null));
                if (!cancellation.IsCancellationRequested) { Process.Start(new ProcessStartInfo(Path.Combine(installed, InstallCore.Entry)) { WorkingDirectory = installed, UseShellExecute = true }); opened = true; }
                else state.Text = "程序已安装，已取消自动打开。";
            }
            catch (OperationCanceledException) { state.Text = "已取消，重试将复用已校验的数据。"; }
            catch (Exception error) { state.Text = "安装未完成，已有工程保持保留。"; MessageBox.Show(this, error is WebException ? "GitHub 下载暂时失败，请检查网络后重试。已下载的数据保留在安装位置旁。" : error.Message, "安装未完成", MessageBoxButtons.OK, MessageBoxIcon.Information); }
            finally { busy = false; cancellation.Dispose(); cancellation = null; install.Enabled = browse.Enabled = target.Enabled = true; if (opened || closeRequested) Close(); }
        }
    }

    internal static class Program
    {
        [STAThread] private static int Main(string[] args)
        {
            ServicePointManager.SecurityProtocol = SecurityProtocolType.Tls12;
            if (args.Contains("--self-test")) return SelfTest(args);
            Application.EnableVisualStyles(); Application.SetCompatibleTextRenderingDefault(false);
            try { Application.Run(new InstallerWindow(Payload.Parse(Payload.Resource("release-manifest.json")))); return 0; }
            catch (Exception error) { MessageBox.Show(error.Message, "安装程序无法打开", MessageBoxButtons.OK, MessageBoxIcon.Information); return 1; }
        }
        private static int SelfTest(string[] args)
        {
            string result = Argument(args, "--result");
            try
            {
                string fixture = Argument(args, "--manifest"); Payload payload = Payload.Parse(fixture == null ? Payload.Resource("release-manifest.json") : File.ReadAllText(fixture, Encoding.UTF8));
                if (args.Contains("--validate-manifest")) { File.WriteAllText(result, Payload.Json.Serialize(new { passed = true, bytes = payload.Bytes, parts = payload.Parts.Count }), new UTF8Encoding(false)); return 0; }
                CancellationTokenSource cancel = new CancellationTokenSource(); if (args.Contains("--cancel-before")) cancel.Cancel();
                string target = InstallCore.Run(payload, Argument(args, "--target"), cancel.Token, delegate(InstallProgress value) { if (args.Contains("--cancel-on-extract") && value.Message == "正在准备程序文件") cancel.Cancel(); }, Argument(args, "--parts"));
                File.WriteAllText(result, Payload.Json.Serialize(new { passed = true, target = target }), new UTF8Encoding(false)); return 0;
            }
            catch (Exception error) { if (result != null) File.WriteAllText(result, Payload.Json.Serialize(new { passed = false, cancelled = error is OperationCanceledException, error = error.Message }), new UTF8Encoding(false)); return 1; }
        }
        private static string Argument(string[] args, string name) { int index = Array.IndexOf(args, name); return index >= 0 && index + 1 < args.Length ? args[index + 1] : null; }
    }
}
