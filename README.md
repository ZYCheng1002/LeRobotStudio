# LeRobotStudio

本地 LeRobot v3 数据质检平台。Python 提供数据读取与视频解码，浏览器提供紧凑的自适应界面，不需要 Node.js、LeRobot 模型或在线 CDN。

## 启动

```bash
conda activate lerobot_v3
cd /home/zycheng/projects/BC_Tools/LeRobotStudio
pip install -r requirements.txt
python -m lerobot_studio
```

打开 http://127.0.0.1:8765 。按 Ctrl+C 关闭服务。也可以使用 `python -m lerobot_studio --config /path/to/config.yaml`。

## 配置与导入

参数集中在 `config.yaml`。启动时不自动加载数据集，点击“导入文件夹”选择要检查的数据。`dataset.browse_root` 是文件夹浏览器的起始目录，也限定可浏览、导入的目录范围。可以逐级浏览，也可直接粘贴绝对路径再导入。选择包含 `meta/info.json` 的目录。这里访问的是 **Python 服务所在机器的文件夹**，无需上传大量视频；远程运行时同样填写服务器路径。

默认监听本机。此工具面向本地单用户使用，没有登录系统，不应直接暴露到公网。同一进程多个标签页保存会串行写入；不要对同一数据目录同时启动多个服务进程。

## 质检操作

- 左侧显示全部 episode，可搜索 ID / 任务、筛选已标注和未标注，标注后立即显示标签。
- 上方默认预留四个相机位置，实际视频特征自动读取；配置 `ui.camera_slots: 2` 可让双相机占满一排。三路、四路相机会自动显示。
- 下方左侧为机械臂、右侧为灵巧手关节图。默认读取 `observation.state`，按 `arm.` / `hand.` 分组。自定义数据可在 `charts.groups` 设置前缀或显式维度 `indices`。数值保持原始单位，不强制转换成角度制。
- 图中点击、拖动或底部时间轴定位帧；滚轮缩放、Shift + 拖动平移、双击恢复。图例可开关单个关节。红色游标和曲线上圆点表示当前帧。
- 空格播放 / 暂停，左右方向键或按钮逐帧移动，也可输入帧索引。支持 1×、1.5×、2×，可在配置扩展。帧索引从 0 开始。
- 每次显示同时提交全部相机图像和关节游标。播放按真实时间推进，解码或网络较慢时会跳过显示帧以追赶倍速；暂停逐帧查看不跳帧。采用 Python 解码，因此浏览器无需支持源视频 AV1 编码。
- 标注位于底部，支持多选“建议合格”“犹豫”“抖动”“其他”，选择“其他”必须填写文字。标注针对整条 episode，额外记录保存时帧索引。保存后可随时修改。切换 episode / 数据集时自动保存未提交内容；无效标注会阻止切换并显示原因。

## 标注文件

唯一写入的数据集文件是 `meta/annotation.json`，不修改视频、parquet 和其他元数据。保存采用临时文件 + 原子替换，按 episode ID 更新，保留其他 episode 的标注，同时保留当前 episode 的 `point` 等扩展字段。转换器预填的空标签记录视为未标注。

```json
{
  "schema_version": 1,
  "episodes": {
    "0": {
      "episode_index": 0,
      "labels": ["抖动", "其他"],
      "note": "抓取阶段有停顿",
      "review_frame": 158,
      "updated_at": "2026-09-17T10:00:00+00:00"
    }
  }
}
```

ID 使用数据中的 `episode_index`，不使用列表位置或共享视频文件名。重新打开数据集会读取已有标注。

## 实现范围

支持 `codebase_version: v3.0`，读取 `meta/episodes/**/*.parquet` 中的分片索引及每相机 `from_timestamp`，定位共享视频。当前相机显示支持 `dtype: video`；不包含嵌入 parquet 的 `dtype: image` 图像模式。图表读取配置指定的一个向量特征。视频解码状态按相机复用，关节数据缓存最近一个 episode；不预加载全部视频。

代码分为 `Dataset` / `VideoDecoder`（只读数据）、`AnnotationStore`（标注）、`Studio` / `RequestHandler`（服务）、`StudioApp` / `JointChart`（界面）。前端采用原生 JavaScript 与 Canvas，依赖仅来自 `requirements.txt`。
