# 图转文字 OCR - Chrome 扩展

Chrome 扩展，支持在网页内完成截图、本地离线 OCR 识别、文本编辑与复制，全程无需上传任何数据。

## 功能

- **悬浮图标入口**: 页面右下角悬浮图标，点击展开操作面板
- **三种截图模式**: 可视区截图 / 选区截图 / 整页长图截图
- **本地离线 OCR**: 基于 PaddleOCR PP-OCRv4，中文识别准确率高，支持中英混排
- **结果面板**: 可编辑文本、复制全部、复制选中，支持拖拽移动
- **历史记录**: 本地保存最近 30 条识别记录，支持回看、复制、删除
- **识别后自动复制**: 默认开启，识别完成后自动复制结果到剪贴板
- **设置页**: 快捷键显示与跳转、悬浮图标开关、自动复制、默认截图模式
- **隐私安全**: 所有处理在本地完成，不上传任何截图或识别内容

## 快捷键

扩展未预设默认快捷键，用户可在 `chrome://extensions/shortcuts` 中自行绑定（也可通过 popup 设置页的"前往设置"按钮跳转）：

| 命令 | 说明 |
| --- | --- |
| 可视区截图 | 直接截取当前可视区域并识别 |
| 选区截图 | 进入选区模式，框选区域后识别 |
| 整页长图截图 | 滚动采集整页并识别 |
| 显示/隐藏入口 | 切换页面悬浮图标显示 |
| 打开最近结果 | 重新打开上一次识别结果 |

面板内快捷键：

| 按键 | 功能 |
| --- | --- |
| `Esc` | 关闭面板 / 取消选区 |
| `Ctrl+Enter` | 复制结果并关闭面板 |

## 安装

1. 克隆或下载本目录
2. 在目录下运行 `npm install` 安装 onnxruntime-web 依赖
3. 打开 Chrome，进入 `chrome://extensions/`
4. 开启 **开发者模式**
5. 点击 **加载已解压的扩展程序**，选择 `ocr-extension-mvp` 目录

## 技术架构

```
manifest.json           — MV3 扩展配置
models/                 — PP-OCRv4 ONNX 模型 (检测 + 识别 + 字典)
src/background/         — Service Worker (截图、消息路由、历史管理、keepalive)
src/content/            — Content Script (悬浮图标、结果面板、选区覆盖层)
src/offscreen/          — Offscreen Document (PaddleOCR 推理、图像裁剪/拼接)
src/popup/              — Popup 页面 (设置与帮助)
```

- **PaddleOCR PP-OCRv4**: 百度开源 OCR 模型，中文识别准确率远超 Tesseract.js
- **ONNX Runtime Web**: WASM 推理引擎，在浏览器中运行 ONNX 模型
- **两阶段流水线**: DBNet 文字检测 → CRNN+CTC 文字识别
- **Shadow DOM**: 内容脚本使用 Shadow DOM 隔离样式，避免与页面冲突
- **Offscreen Document**: Chrome MV3 专用机制，用于运行 Canvas 和 OCR 推理
- **Service Worker keepalive**: 端口保活机制，防止长时间 OCR 期间 Service Worker 被终止
- **chrome.storage.local**: 历史记录和设置持久化存储

## 注意事项

- 首次 OCR 识别时需加载模型（约 15MB），已随扩展打包，无需联网下载
- 模型加载后缓存在内存中，后续识别速度更快
- 整页长图截图模式下，页面中的 fixed/sticky 元素会被临时隐藏
- 超长页面的长图模式可能消耗较多内存
