# 土豆题库

轻量的刷题网站，前端保持无登录界面，后端使用 Python 与 SQLite 持久化题库、完成记录、错题、练习偏好和最近答题位置。题库文件导入可选择普通识别或 DeepSeek-V4-Flash 固定 JSON 校对。

## 本地预览

```bash
python3 server.py
```

访问 `http://127.0.0.1:8088`。

首次访问时服务器会通过 HttpOnly Cookie 自动建立匿名设备档案，不需要注册或登录。浏览器本地存储继续作为离线降级；服务器可用时，页面顶部会显示“已保存”，所有改动会自动写入 SQLite。默认数据库位于 `data/quiz.db`，可通过环境变量修改：

```bash
QUIZ_DB_PATH=/var/lib/quiz-site/quiz.db python3 server.py
```

生产环境建议使用 HTTPS，以保护题库内容和匿名档案 Cookie。

## 数据持久化接口

- `GET /api/state`：读取当前匿名档案的保存记录；不存在时自动创建档案。
- `PUT /api/state`：保存题库、完成记录、错题、设置和最近练习位置。
- `GET /api/health`：检查服务、SQLite 和 AI 配置状态。
- `POST /api/import`：导入并拆分题库文件。
- `POST /api/explanations/stream`：以 SSE 实时生成一道或多道题目解析。
- `POST /api/tutor/stream`：携带完整题目和历史问答，以 SSE 实时继续追问当前解析。
- `POST /api/explanations`、`POST /api/tutor`：保留的非流式兼容接口。

后续接入统一平台账号时，可由可信反向代理写入用户 ID 请求头，并设置 `TUDOU_TRUSTED_IDENTITY_HEADER`。存储层会自动从匿名设备身份切换为平台身份，前端状态结构无需改动。切勿让公网客户端直接控制该请求头。

支持顺序/乱序单选、顺序/乱序多选、错题重练。答题模式页面提供“打乱选项顺序”勾选项，题目乱序与选项乱序可以独立选择；选项重排后正确答案字母会自动同步映射，该偏好会随题库和刷题进度一同保存。答错的题目会持续收集到独立错题集，用户可按题库查看、练习、移出或清空。每个导入文件会保存为一个独立题库文件夹，文件夹内的题目按单选/多选统计和筛选；导入题库可从题库卡片直接删除，删除时同步清理该题库的进度与错题记录。导入后每道题都会拆成独立题卡和独立选择界面。

## 多格式导入

单个文件不超过 25 MB。支持：

- Word：`.doc`、`.docx`
- PDF：文本 PDF 直接提取；扫描页自动转为图片并 OCR
- 图片：`.png`、`.jpg`、`.jpeg`、`.webp`、`.bmp`、`.tif`、`.tiff`
- 文本：`.txt`、`.md`、`.csv`、`.html`、`.htm`
- Office/OpenDocument：`.xlsx`、`.pptx`、`.odt`

图片和扫描 PDF 使用服务器本地 Tesseract（`chi_sim+eng`）识别，原图不会发送给 DeepSeek；精确识别只发送提取后的题目文字。生产服务器需安装 `antiword`、`poppler-utils`、`tesseract-ocr`、`tesseract-ocr-chi-sim` 和 `tesseract-ocr-eng`。

Word 文档会先转换文本再逐题拆分；加密/受保护的 Office 文档无法直接解析，请先解除保护并另存为普通 `.docx`。可以额外提供以下元数据行：

```text
题型：多选
分类：线性规划
难度：进阶
```

答案可以写在每道题后，例如 `答案：B` 或 `答案：A、C`；也支持文档末尾的 `参考答案：1.B 2.AC` 答案表，以及在 Word 中将正确选项加粗。普通识别会逐题规范化并校验题干、选项和答案，过滤纯标点伪选项、重复选项及完全重复题目。答案只有一个字母时归为单选，包含多个不同字母时归为多选。

## DeepSeek AI 识别

AI 导入会先执行本地文件提取与拆分，再将结构化题目文字分批发送给 `deepseek-v4-flash`，使用 `response_format: {"type":"json_object"}` 返回固定 JSON。提示词专门处理 OCR 断行、题干错位和粘连选项；服务器会再次校验题目数量、ID、选项和答案对应关系，并根据答案字母数量重新判定单选/多选。导入阶段不生成解析。

逐题解析、答题结束后的错题解析以及解析后的继续追问均使用 SSE：DeepSeek 上游返回最终答案分片后，Python 后端立即转发，页面边接收边显示。`reasoning_content` 不会发送给浏览器。解析与追问使用 Markdown 输出，本地固定版本的 `markdown-it` 负责标题、列表、加粗、引用、代码和表格渲染；原始 HTML 被禁用，危险链接被过滤，外部链接会附加安全属性。

逐题解析使用思考模式生成更具体的依据、错选原因和易混淆点。学生看完解析后可继续追问，追问输入框支持 Enter 发送、Shift+Enter 换行；由于 DeepSeek Chat API 无状态，后端会在每轮请求中重新提交固定题目上下文、初始解析及成对的历史问答。前端永远不会接触 API Key。

生产服务使用 systemd credential 读取 `/etc/quiz-site/deepseek_api_key`，API Key 不应写入网页、JavaScript、Git 仓库或普通日志。
