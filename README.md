# 截图组卷

这是独立重建的 Windows 应用，源码、构建产物和数据均位于本目录。旧版入口和服务不参与新应用的运行。

## 下载版使用

**[下载 Windows 安装程序](https://github.com/holdenxiang-eng/paper-geometry-studio-desktop/releases/latest/download/PaperStudio-Setup.exe)** · [全部发布文件](https://github.com/holdenxiang-eng/paper-geometry-studio-desktop/releases/latest)

1. 下载并双击 `PaperStudio-Setup.exe`，选择有写入权限、至少有 10 GB 可用空间的位置，例如 D 盘，点击“安装并打开”。首次自动下载约 3 GB 完整组件，显示进度，可取消和重试。无需手动拼接分卷，也不需要 API 密钥、Python、Node 或 7-Zip。
2. 安装完成后，日常双击安装目录里的 `截图组卷.exe`。首次资源准备只进行一次，日常启动不重新解压模型。移动程序时一起移动整个文件夹；不要只复制这个小 EXE。若已经通过其他方式拿到完整便携 ZIP，也可完整解压后运行。
3. 导入多张截图，等待各自处理状态完成后校对题文、公式、图号和几何关系；可以选择题图、拖动顶点和调整排版。准备完成后导出 Word 或 PDF。
4. 退出前点击“保存工程”，保存为 `.paper.json`。已保存的工程可以再次打开继续调整。

本地识别无需 API 密钥或订阅账号，截图不发送至云端。识别速度受 CPU、可用内存、截图清晰度、题目和图形数量影响；公式、模糊字母、复杂构造仍可能需要人工校对，不保证自动识别全部正确。界面启动、模型准备、截图处理是三个独立阶段，不能把加载提示框出现当作工作台可操作。

运行环境为 Windows 10/11 x64，并已具备系统 WebView2 Runtime，建议至少 16 GB 内存。没有 WebView2 的电脑不在当前支持范围内，请换用具备该组件的电脑。识别所需的 Visual C++ 运行文件已随程序携带，不需要安装开发环境；安装程序不会改动系统组件。

## 运行边界

- 唯一入口是 `dist/截图组卷.exe`。窗口直接显示本地界面，启动不解压、不校验模型，也不扫描历史版本。
- 系统 WebView2 负责界面和 PDF 打印。识别与 Word 导出由独立 Python worker 处理；worker 缺失、正在准备或识别失败均不阻止编辑、导入、打开和保存工程。
- 图片任务有独立 ID、取消状态和结果顺序。最多两张同时处理，结果仅应用到仍存在的原截图。
- 文档明确保存标题、段落、小问、公式、选项和图形块，预览和导出消费同一结构。原图中的 `计算：`、`(1)`、`(2)` 若分三行，新文档也分三行；原图确实同行时保持同行，不通过统一猜测改写原行。
- 题型固定按选择、填空、判断、应用分组，省略空类别，每类从 1 编号。应用题默认留 24 mm 答题区，其余不留；原图图号、字母位置、选项行列和图文顺序随工程保留。

## 资源与数据

`dist/resources` 存放稳定的识别资源；`dist/data` 存放本应用自己的状态、缓存和临时文件。应用升级不复制整套模型，不写 C 盘 AppData。

发布 ZIP 不包含本机的 `data`、截图、已保存工程、密钥配置、日志、下载缓存、临时文件、测试或 Python 字节码缓存。许可证保留在 `licenses`、`resources/licenses` 和 Python 包的 `.dist-info` 中。可选的 RapidLaTeXOCR 实验模型 `resources/models/formula` 不属于当前识别提供者，不进入默认发布包，也不会从本机删除；生产 RapidOCR 的三个 ONNX 模型仍保留。

升级时先关闭程序，再将新包解压覆盖同一个程序文件夹；发布包不包含 `data`，不会用空数据覆盖用户状态。请自行保留已保存的 `.paper.json` 文件。

`ui/geometry` 中的几何求值、像素测量和交互算法来自本项目已验证的纯算法模块，在新应用中独立使用。新文档模型、页面状态、任务调度、宿主和 IPC 都是独立实现，不引用旧应用入口。

## 构建

在本项目根目录运行以下命令。资源默认从锁定的官方地址下载，不依赖旧工程。已有相同公开模型时，也可显式传入 `--vision-assets-from` 以校验和复用，避免重复下载。编译需要 Windows 的 .NET Framework x64 C# 编译器；准备 CRT 发布文件需要脚本锁定的 Visual Studio 非调试 x64 Redist 目录。

```powershell
npm install
python scripts/prepare-ui.py
python scripts/setup-worker.py
python scripts/prepare-desktop-runtime.py
python scripts/build-native.py
python scripts/package-portable.py --dry-run
python scripts/package-portable.py
python scripts/package-release.py --tag v0.1.1
```

`setup-worker.py` 从官方源准备锁定版本的独立 Python、OCR 和 Word 依赖，资源哈希记录于 `dist/resources/worker-lock.json` 与 `vision/assets-lock.json`。`build-native.py` 校验官方 WebView2 SDK 并编译轻量宿主、复制当前 UI/worker 到 `dist`。业务源码发生变化后，先重新运行 `build-native.py`，再打包。

`package-portable.py` 只读取已构建的 `dist`，不下载、不安装、不创建自解压包、不生成多版本运行目录。`--dry-run` 核对必要文件、入口/SDK 哈希和应用副本，不读写大模型负载；正式打包边写边核对模型、CRT 和许可锁哈希，校验 ZIP CRC，最后输出 ZIP 和 `.zip.sha256`。默认产物为 `release/截图组卷-Windows-x64.zip`，ZIP 根目录只有一个 `截图组卷` 文件夹。

`package-release.py` 将已验收的 ZIP 切成小于 GitHub 单附件限制的数据文件，生成内嵌静态地址、长度和 SHA256 的一次安装程序。安装程序下载并验证分卷，通过跨分卷流解压，不重复落一份完整 ZIP。发布 `release/github-v0.1.1` 中的安装器、两个分卷、清单及校验文件即可；用户只需下载安装器。

```powershell
npx playwright install chromium
npm test
dist/resources/python/python.exe -X utf8 -m unittest discover -s tests -p "test_*.py"
```

首次准备/下载/解压属于安装步骤，界面启动不重新下载、解压或校验几 GB 模型。发布前需要重新测量实际 EXE 的可操作时间，并验收真实多截图处理、项目保存/恢复、Word 公式结构和 PDF 页面；自动测试通过不等于所有照片都能准确识别。
