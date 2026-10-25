<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/matos-logo-dark.svg">
    <img src="docs/assets/matos-logo.svg" alt="MatOS" width="720">
  </picture>
</p>

<p align="center">
  <strong>描述一个材料科研任务，MatOS 组合所需的科学资产，以有状态、可检查的工作流执行到底，并把每次运行的经验沉淀为下一次可用的资产。</strong>
</p>

<p align="center">
  <a href="README.md"><img src="https://img.shields.io/badge/English-README-blue" alt="English"></a>&nbsp;
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-PolyForm%20Noncommercial%201.0.0-blue.svg" alt="PolyForm Noncommercial 1.0.0"></a>&nbsp;
  <img src="https://img.shields.io/badge/Linux-x86__64-FCC624?logo=linux&logoColor=black" alt="Linux x86_64">&nbsp;
  <img src="https://img.shields.io/badge/Node.js-24-339933?logo=nodedotjs&logoColor=white" alt="Node.js 24">&nbsp;
  <img src="https://img.shields.io/badge/Bun-1.3.14-000000?logo=bun&logoColor=white" alt="Bun 1.3.14">&nbsp;
  <img src="https://img.shields.io/badge/Python-3.9+-3776AB?logo=python&logoColor=white" alt="Python 3.9+">
</p>

---

## 目录

- [MatOS 是什么？](#matos-是什么)
- [核心设计](#核心设计)
- [基准评测结果](#基准评测结果)
- [本版本包含什么](#本版本包含什么)
- [命令行](#命令行)
- [快速开始](#快速开始)
- [基本使用](#基本使用)
- [架构](#架构)
- [配置](#配置)
- [运行基准评测](#运行基准评测)
- [文档](#文档)
- [贡献](#贡献)
- [引用](#引用)

## MatOS 是什么？

MatOS 是一个**面向材料科研的智能体操作系统**。材料研究往往持续数天，在文献、计算与实验之间反复迭代，研究问题和方法也随结果不断变化。这要求智能体能持续接入新的数据和软件，让长链条任务稳定推进，并记住以往任务积累的经验。MatOS 把这些能力统一组织为带版本的**科学资产**：数据、知识、工具、技能、角色与工作流。

<p align="center"><img src="docs/assets/figures/matos-overview.png" width="900" alt="MatOS 系统架构总览"></p>

<p align="center"><em>研究任务驱动有状态自适应工作流，分层科学资产图提供可组合的科研能力；执行轨迹与用户反馈经评审形成资产修订，回流资产图。</em></p>

**核心特性：**

- **分层科学资产图** — 六类带版本的资产分布在四个语义层上，由六种有向关系连接，并区分共享、用户、项目三级作用域。新能力以新资产的形式接入，角色复用资产而不是复制资产。
- **有状态自适应工作流** — 九种节点类型，支持 DAG 与状态机两种执行模式、MAP 与 LOOP、重试、暂停、取消和人工确认。图快照、事件日志和按尝试记录的产物让长任务可以恢复、可以追溯。智能体可以提出修改执行图，但必须先通过图结构、策略和编译检查才会生效。
- **证据驱动的资产演化** — 五个隐藏的系统角色把执行记录和用户反馈转化为有针对性的资产修订，每次修订都要通过结构检查和语义评审。审批可设为关闭、人工或自动，演化页面展示待审提案、修订历史和每个资产的版本谱系。
- **科研基准验证** — 在 ResearchClawBench 上比此前最佳智能体高 11.15%，并扩展了成本—得分帕累托前沿；在 MatTools 和 SciAgentGym 上，相同基座模型下优于 Codex CLI 与 Claude Code（[详见结果](#基准评测结果)）。
- **浏览器工作区** — 定制的 OpenDesign 界面：项目、持久对话、文件、预览、终端、资产与工作流视图，以及 MatterViz 晶体结构查看器。
- **DeepSeek Harness 执行引擎** — 由 DeepSeek Harness（MIT）负责智能体循环和原生工具。默认模型为 DeepSeek-V4-Flash，也可通过 `DEEPSEEK_BASE_URL` 接入任何兼容网关。
- **一键部署** — `./deploy.sh` 问几个问题，完成 18 项系统检查，下载私有的 Node.js 和 Bun 并校验，然后安装、启动并验证模型。全程不需要 root，每个报错编号都有对应的处理方法。
- **基准评测入口** — 提供 MatTools、SciAgentGym 和 ResearchClawBench 的准备、运行与评分入口，使用冻结的 28 项 benchmark 资产档，评测时关闭演化。

## 核心设计

### 分层科学资产图

科学资产是带有唯一标识和类型、声明了版本和依赖、并通过内容入口或外部资源引用提供科研能力的对象。MatOS 区分六类资产，按其典型前置关系分为四个语义层：

<p align="center"><img src="docs/assets/figures/asset-graph.png" width="900" alt="分层科学资产图"></p>

| 符号 | 类型 | 层 | 科学含义 |
|:----:|------|:--:|----------|
| `D` | **数据** | 0 | 材料体系及其计算或实验过程的记录：测量值、模拟输出、结构、参数和数据源引用 |
| `K` | **知识** | 1 | 从观测中归纳出的规律及其适用条件：物理定律、经验判断、方法使用知识 |
| `T` | **工具** | 1 | 以材料求解器为核心的可调用能力：软件接口、检索与处理程序、校验脚本、仪器接口 |
| `S` | **技能** | 2 | 一类问题的方法：如何选择和使用知识与工具，以及如何检查结果 |
| `R` | **角色** | 3 | 一种智能体配置：职责提示词，加上它可以选择、组合和调用的资产 |
| `W` | **工作流** | 3 | 可复用的流程描述，通过节点、依赖和控制条件组织工具、角色和子工作流 |

有向边 `a → b` 统一由引用方指向被引用对象：

| 关系 | `a → b` 的含义 | 典型连接 |
|------|----------------|----------|
| `DEP` 依赖 | 使用 `a` 需要 `b` 提供的数据、知识或能力 | `S → D, K, T` · `T → K` |
| `MOUNT` 挂载 | `b` 成为 `a` 可选择、可组合的能力之一 | `R → D, K, T, S, W` · `S → K, T` |
| `CALL` 调用 | `a` 可以把求解或决策委托给 `b` | `R → T, R, W` |
| `PART` 组成 | `a` 描述的流程中有一个阶段由 `b` 处理 | `W → T, R, W` |
| `EVIDENCE` 证据 | `b` 为 `a` 中的结论或结果提供可追溯的证据 | `K, S, W → D, K` |
| `VERIFY` 校验 | `b` 规定或执行对 `a` 的检查 | `K, S, W → T, S, W` |

每个任务中，角色的有效能力由它沿 `DEP`、`MOUNT`、`CALL` 可达的子图在当前作用域和已接受版本下组合而成。多个角色可以挂载同一个技能，不同工作流也可以调用同一个角色。

### 有状态自适应工作流

模型采样存在随机性，长任务中的决策也会随上下文变化而漂移。因此 MatOS 用显式执行图运行关键计算，图中保存任务步骤、状态和检查规则。运行时管理参数、作业和证据，智能体负责修订计划、解释异常。

<p align="center"><img src="docs/assets/figures/stateful-workflow.png" width="900" alt="有状态自适应工作流"></p>

| 节点 | 科研职责 |
|------|----------|
| `AGENT` | 问题分解、方法选择、异常解释等开放决策，交给科研角色处理 |
| `EXEC` | 执行指定的计算、数据处理或分析步骤 |
| `BACKEND` | 通过显式提供的适配器，在外部计算平台或仪器上组织作业 |
| `GUARD` | 按科学或流程条件检查输入和中间结果 |
| `HUMAN` | 需要研究者判断、补充信息或确认的环节 |
| `SUBWORKFLOW` | 把可复用的研究流程作为一个完整子任务调用 |
| `MAP` | 把同类子任务展开到多个候选材料或研究条件上 |
| `LOOP` | 带次数上限和停止条件的有界迭代 |
| `DYNAMIC` | 随任务推进提出对后续步骤和依赖的修改 |

- **两种执行模式。** DAG 模式下，调度器检查前驱、输入和分支条件，把就绪节点派发给对应执行器。状态机模式下，系统依据节点结果和显式转移条件按研究阶段推进，回到前一阶段的转移构成反馈环。
- **状态独立于会话。** 图快照、节点记录和事件日志独立于模型上下文持久保存。长作业可以交给后台进程推进并定期写入心跳。运行结束、等待输入或心跳丢失时，观察器把事件注入智能体上下文，智能体通过事件游标读取新事件，不必轮询。
- **受检查的图修改。** 修改提案 `δ` 只有通过图结构、策略和编译三项检查，才会编译为新版本 `W(k+1)`。每个提案、每项检查和最终决定都会被记录；未获通过时，当前执行图照常运行。

### 证据驱动的资产演化

任务记录和用户反馈中包含可复用的方法、失败原因、计算环境要求和用户偏好。MatOS 把这些经验写入资产，基座模型参数保持不变。

<p align="center"><img src="docs/assets/figures/asset-evolution.png" width="900" alt="证据驱动的资产演化"></p>

1. **证据评议**：评议者判断执行轨迹、用户反馈和工作流结果构成的证据是否充分、问题是否成立、经验是否可复用，并区分共享的方法知识与用户或项目的个人偏好。
2. **目标定位**：优先选择证据中明确指出的资产，再按图关系和文本相关性补充相关候选，上下文规模有上限。
3. **定向编辑**：编辑者提出协调一致的修订，可以同时修改多个资产，也可以新建资产。被拒绝的提案按拒绝理由修改后重试，最多三次。
4. **双重验收**：确定性检查校验资产描述、接口和组合关系；有修订前基线时，对比修订前后的错误集合，只有修订*新引入*的错误才会阻止通过。随后由语义评审确认修订回应了原始证据，并保持方法的适用条件。
5. **版本采纳**：通过验收的版本发布到所属作用域。新对话立即使用，已打开的对话在下一轮使用。

| 审批模式 | 行为 |
|----------|------|
| `off` | 不运行自动演化 |
| `manual`（默认） | 通过全部检查的修订作为提案，在演化页面等待批准或拒绝 |
| `auto` | 通过全部检查的修订立即被接受 |

审批模式可以在演化页面、设置中或通过 `matos evolve policy` 设置，也可以用 `MATOS_EVOLUTION_APPROVAL_MODE` 为整个服务固定。

## 基准评测结果

MatOS 在三个层面接受评测：[ResearchClawBench](https://arxiv.org/abs/2606.07591) 上的端到端科研、[MatTools](https://arxiv.org/abs/2505.10852) 上的材料工具使用，以及 [SciAgentGym](https://arxiv.org/abs/2602.12984) 上的多步科学问题求解。以下图表均来自 MatOS 技术报告。

### 端到端科研：ResearchClawBench

评测使用由已发表论文构建的 12 个化学、能源与材料任务。系统拿到相关文献和原始数据，但看不到目标论文，需要独立完成研究并撰写报告，再由专家设计的加权评分项打分。MatOS 使用 DeepSeek-V4-Flash 得 **19.20** 分，使用 GPT-5.4 得 **19.46** 分，分别比此前报告的最佳 GPT-5.4 系统 MIRA 高 **9.63%** 和 **11.15%**。所有基线均使用 GPT-5.4，其分数和成本取自 MIRA 技术报告。

<p align="center"><img src="docs/assets/figures/rcbench-scores.png" width="820" alt="ResearchClawBench 各领域及总体得分"></p>

<p align="center"><em>柱形为各领域得分，横线为总体得分（同时标在系统名下方）。</em></p>

两个 MatOS 配置都扩展了观测到的成本—得分帕累托前沿。DeepSeek-V4-Flash 配置以接近最强基线的成本取得了更高的分数。

<p align="center"><img src="docs/assets/figures/rcbench-cost.png" width="720" alt="ResearchClawBench 成本与得分"></p>

<p align="center"><em>平均执行成本（对数坐标）与总体得分，虚线连接非支配点。</em></p>

### 工具使用：MatTools 与 SciAgentGym

三个系统统一使用 **DeepSeek-V4-Pro** 作为基座模型，以区分智能体系统本身的作用。MatTools 包含基于 pymatgen 及其缺陷扩展的 49 个问题、138 个性质计算子任务，由单元测试判定。SciAgentGym 使用 42 个公开的化学与材料案例，需要组合多个领域工具，答案完全正确才计为成功。

<p align="center"><img src="docs/assets/figures/tool-benchmarks.png" width="900" alt="MatTools 与 SciAgentGym 结果"></p>

<p align="center"><em>（a）MatTools 子任务成功率（实色）与完整问题成功率（斜线）；（b）SciAgentGym 案例成功率，括号内为解出的案例数。</em></p>

### 结果汇总

| 基准 | 基座模型 | MatOS | 最强基线 |
|------|----------|-------|----------|
| ResearchClawBench，12 个任务 | DeepSeek-V4-Flash | **19.20**（平均成本 $0.85） | MIRA，GPT-5.4：17.51（$0.67） |
| ResearchClawBench，12 个任务 | GPT-5.4 | **19.46**（平均成本 $3.78+） | MIRA，GPT-5.4：17.51（$0.67） |
| MatTools，49 个问题 / 138 个子任务 | DeepSeek-V4-Pro（各系统相同） | **48/49** · **134/138** | Codex CLI：47/49 · 132/138 |
| SciAgentGym，42 个案例 | DeepSeek-V4-Pro（各系统相同） | **25/42**（59.5%） | Codex CLI、Claude Code：24/42（57.1%） |

## 本版本包含什么

本仓库是 MatOS 的开源单用户版本，随附两套资产档：

| | workspace 档（默认） | benchmark 档 |
|---|:---:|:---:|
| 角色 | 7（Compute、Research Scientist + 5 个隐藏演化角色） | 2（Compute、Research Scientist） |
| 技能 | 7 | 5 |
| 工具 | 18 | 18 |
| 知识 | 2 | 1 |
| 数据（机器学习势模型记录） | 2 | 2 |
| 工作流 | 1（本地数值计算示例） | 0 |
| **合计** | **37** | **28** |
| 演化 | 开启，人工审批 | 关闭 |

科学计算用的 Python 环境、机器学习势模型和 benchmark 数据需要另外安装，并在[配置](#配置)中指向它们。

## 命令行

浏览器工作区是主要入口，它能做的事情也都可以通过 `bin/matos` 完成。把 `bin/` 加入 `PATH`（`export PATH="$PWD/bin:$PATH"`），或直接调用 `bin/matos`。

| 命令 | 说明 |
|------|------|
| `matos` | 交互式会话（用 `--role`、`--asset` 选择角色和额外资产） |
| `matos run "<任务>"` | 用指定角色和资产执行一个任务后退出 |
| `matos roles list \| show` | 可选角色及其组合的资产 |
| `matos assets list \| show \| validate \| graph` | 浏览、校验科学资产并查看资产图 |
| `matos skills` | 列出可用技能 |
| `matos workflow list \| run \| runs \| inspect \| events` | 运行工作流，查看运行记录和事件日志 |
| `matos workbench workflows \| projects \| feedback \| models \| search` | 浏览器工作区使用的工作台视图 |
| `matos evolve status \| monitor \| feedback \| policy` | 演化状态、反馈和审批模式 |
| `matos login status \| set \| test \| reset` | 模型凭据，以及一次真实的连通测试 |
| `matos usage profile` | Token 用量 |

大多数命令加 `--json` 可输出机器可读结果。

## 快速开始

### 一键部署（推荐）

```bash
git clone https://github.com/DingyangLyu/MatOS.git
cd MatOS
./deploy.sh init   # 回答几个问题，生成配置文件 matos-deploy.conf
./deploy.sh        # 检查 → 安装 → 启动 → 验证
```

`./deploy.sh` 会检查机器，需要时下载私有的 Node.js 24 和 Bun 1.3.14，然后安装、构建工作区、启动服务，并真实调用一次模型进行验证。网络正常时首次部署约 4–10 分钟，之后重新部署只需几十秒。

然后打开 **http://127.0.0.1:17474/**。服务只监听本机回环地址，从你自己的电脑访问服务器时请使用 SSH 隧道：

```bash
ssh -N -L 17474:127.0.0.1:17474 you@server
```

如果部署时没有填写 DeepSeek API Key，第一次打开网页时欢迎页会提示你填写。

### 前置要求

- Linux x86_64，glibc 2.28 或更高（Ubuntu 20.04+、Debian 10+、RHEL/Rocky/Alma 8+）。
- Python 3.9+、Git、C/C++ 编译器和 `make`。Node.js 和 Bun 不必预装，部署脚本会下载私有版本。
- 内存 4 GB 以上，程序约占 3 GB 磁盘，数据目录另算。
- 能访问 npm 依赖源、Node/Bun 下载地址和 DeepSeek API，支持国内镜像和代理。
- [DeepSeek API Key](https://platform.deepseek.com) 或兼容网关。**不需要** root 权限。

### 日常使用

| 命令 | 说明 |
|------|------|
| `./deploy.sh status` | 查看是否在运行、是否健康 |
| `./deploy.sh start` / `stop` / `restart` | 启动、停止、重启 |
| `./deploy.sh logs` | 查看最近的服务日志（`--lines 200` 看更多） |
| `./deploy.sh check` | 只做系统检查 |
| `./deploy.sh report` | 打包诊断信息，发给帮你排查问题的人 |
| `./deploy.sh uninstall` | 停止服务并删除开机自启，文件和数据都保留 |

每项检查和每个错误都会显示编号（`C01`–`C18`、`I01`–`I06`、`R01`–`R03`、`A01`）。[部署手册](docs/deploy.md)逐一说明每个编号的含义和处理方法，并介绍升级、备份和迁移。

<details>
<summary><strong>手动安装</strong>（使用系统的 Node.js 24 和 Bun 1.3.14）</summary>

```bash
bash scripts/matos-setup.sh
# 把 .env.example 复制到源码目录之外，填写 DEEPSEEK_API_KEY。
python3 scripts/matos-service.py start \
  --state-dir /path/to/matos-state \
  --env-file /path/to/private/provider.env \
  --port 17474 --daemon-port 17473
```

用同一个状态目录执行 `scripts/matos-service.py status` 或 `stop`。`scripts/matos-web.sh` 调用底层的 OpenDesign 生命周期管理器。

</details>

## 基本使用

在工作区打开一个项目，选择角色，描述任务：

- **Compute** 负责材料计算和以工具为中心的问题：制定计划、检查本地工具链、编写并运行代码，并按要求的格式给出最终答案。
- **Research Scientist** 负责开放式研究：文献调研、数据分析、建模，并撰写研究报告。

在终端里，同样的事情只需一条命令：

```bash
bin/matos run --role compute "用 pymatgen 构建 2×2×2 的岩盐结构 NaCl 超胞，给出密度和空间群"
```

智能体会自动：

1. 在当前作用域和已接受版本下，组合角色的资产（技能、知识、工具、工作流）
2. 制定计划，并检查所需的科学计算环境是否可用
3. 运行代码、工具或工作流，记录每一步，并检查中间结果
4. 把结果、图表和文件写入项目，并在对话中给出回答
5. 把运行轨迹和你的反馈留作证据，供下一轮[资产演化](#证据驱动的资产演化)使用

## 架构

```
┌────────────────────────────────────────────────────────────────────┐
│ Browser · OpenDesign workspace                     127.0.0.1:17474 │
│ projects · conversations · files · terminal · assets               │
│ workflows · Evolution page · MatterViz structure viewer            │
└────────────────────────────────────────────────────────────────────┘
                                   │
                                   │ HTTP
                                   │
┌────────────────────────────────────────────────────────────────────┐
│ OpenDesign daemon → native matos commands                   :17473 │
└────────────────────────────────────────────────────────────────────┘
                                   │
                                   │ stream-json
                                   │
┌────────────────────────────────────────────────────────────────────┐
│ MatOS runtime                                                      │
│                                                                    │
│ ┌────────────────────┐ ┌─────────────────────┐ ┌─────────────────┐ │
│ │ Scientific assets  │ │ Workflow runtime    │ │ Evolution       │ │
│ │ D K T S R W        │ │ DAG / state machine │ │ critic → editor │ │
│ │ bundled · user ·   │ │ snapshots · events  │ │ checks → judge  │ │
│ │ project scopes     │ │ artifacts · resume  │ │ → new version   │ │
│ │ local Git refs     │ │ checked graph edits │ │ off/manual/auto │ │
│ └────────────────────┘ └─────────────────────┘ └─────────────────┘ │
│                                                                    │
│ DSH host: role composition · tool rules · skills · MCP             │
└────────────────────────────────────────────────────────────────────┘
                                   │
                                   │ DSH turns
                                   │
┌────────────────────────────────────────────────────────────────────┐
│ DeepSeek Harness: agent loop + native tools (shell, files, web…)   │
└────────────────────────────────────────────────────────────────────┘
                 │                                 │
                 │                                 │
  DeepSeek API / compatible gateway   Host scientific environment
                                      (conda envs, solvers, models)
```

**工作流程：**

1. 浏览器工作区与 OpenDesign 守护进程通信，守护进程调用 MatOS 原生命令并展示结果
2. 对话开始时，MatOS 在项目的作用域和已接受的资产版本下解析角色的能力子图
3. DSH 宿主把组合好的角色、工具规则、技能、MCP 配置和会话标识转换为 DeepSeek Harness 的对话轮次；DSH 执行智能体循环和原生工具，并把事件流式返回
4. 长时或关键计算以工作流运行：运行时调度节点、持久保存状态，并在运行结束或需要输入时唤醒智能体
5. 对话反馈和执行记录交给隐藏的演化角色；通过验收的资产版本发布到作用域的已接受引用，从下一轮起生效

MatOS 负责科学系统，DeepSeek Harness 负责智能体循环，OpenDesign 负责界面。

## 配置

<details>
<summary><strong>部署配置文件和环境变量</strong></summary>

### 部署配置文件（`matos-deploy.conf`）

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| `state_dir` | `~/matos-data` | 项目、对话、资产版本和运行记录；不能放在程序目录里 |
| `web_port` / `daemon_port` | `17474` / `17473` | 网页端口和后台端口 |
| `deepseek_api_key` | 空 | 可选；也可以在网页里填写，网页里的优先 |
| `deepseek_base_url` | 空 | 使用兼容网关时填写 |
| `model` | `deepseek-flash` | 默认模型 |
| `env_file` | `~/.config/matos/matos.env` | 模型配置文件，权限 600 |
| `autostart` | `none` | `none`、`cron`（`@reboot`，不需要 root）或 `systemd-user` |
| `npm_registry` / `node_mirror` / `bun_mirror` | 官方源 | 网络较慢时可用国内镜像 |
| `toolchain_root` / `conda_envs_path` / `mlip_model_root` | 空 | 你的科学计算工具、conda 环境和机器学习势模型目录 |

### 环境变量

| 变量 | 说明 |
|------|------|
| `DEEPSEEK_API_KEY` | 模型 API Key |
| `DEEPSEEK_BASE_URL` | 兼容网关地址 |
| `MATOS_DSH_MODEL` | 智能体使用的模型（默认 `deepseek-flash`） |
| `MATOS_TOOLCHAIN_ROOT` / `MATOS_SYSTEM_CONDA_ENVS_PATH` / `MATOS_MLIP_MODEL_ROOT` | 本机的科学计算目录 |
| `MATOS_EVOLUTION_APPROVAL_MODE` | 为整个服务固定演化审批模式：`off`、`manual` 或 `auto` |
| `MATOS_EVOLUTION_DIRECT_EDITOR_MAX_ATTEMPTS` / `MATOS_EVOLUTION_CRITIC_MAX_ATTEMPTS` | 演化编辑者和评议者的重试上限（默认 3） |

用 `python3 scripts/matos-science-doctor.py --profile all` 检查科学计算环境。

</details>

## 运行基准评测

`scripts/matos-benchmark.sh` 是三套评测共用的求解入口。它固定使用 DeepSeek-V4-Flash、完整 MatOS 上下文和最高推理强度，为每道题准备独立的配置，并关闭演化。各 benchmark 的公开数据需要单独获取，模型 API Key 写在环境文件里：

```bash
export MATOS_BENCH_ENV_FILE=/abs/path/to/provider.env
python3 scripts/matos-mattools-agentic-bench.py prepare --mattools-root "$MATTOOLS_ROOT" \
  --mattools-python "$MATTOOLS_PYTHON" --output-root "$RUNS" --run-id matos --json
python3 scripts/matos-mattools-agentic-bench.py run --run-root "$RUNS/matos" --runner matos \
  --matos-bin "$PWD/scripts/matos-benchmark.sh" ...
python3 scripts/matos-mattools-agentic-bench.py score --run-root "$RUNS/matos" --runner matos ...
```

SciAgentGym（`scripts/matos-sciagentgym-bench.py`）和 ResearchClawBench（`scripts/matos-rcbench-dsh.py`）同样分为准备、运行、评分三步。完整命令、评分设置和资产档导出方法见 [docs/benchmarks.md](docs/benchmarks.md)。

<details>
<summary><strong>项目结构</strong></summary>

```
MatOS/
├── deploy.sh                    # 一键部署 → scripts/matos-deploy.py
├── bin/matos                    # 命令行入口
├── src/
│   ├── entrypoints/             # matos CLI、智能体和演化后台进程入口
│   └── matos/                   # 原生运行时
│       ├── assets/              # 资产模型、校验、本地 Git 验收
│       ├── workflows/           # 工作流运行时：调度、快照、观察器
│       ├── learning/            # 证据驱动的资产演化
│       ├── host/                # DSH 宿主：把角色组合转换为 DSH 轮次
│       ├── runtime/             # DeepSeek Harness 引擎、作用域、部署目录
│       ├── sessions/            # 事件与轨迹记录
│       ├── workbench/           # 浏览器工作区背后的操作
│       └── cli/                 # matos 命令
├── ui/open-design/              # 定制的 OpenDesign 工作区和守护进程
├── vendor/deepseek-harness/     # 固定版本的 DeepSeek Harness 及 MatOS 插件
├── distribution/benchmark-minimal/
│   └── assets/packs/            # 37 项 workspace 档 / 28 项 benchmark 档资产包
├── scripts/                     # 安装、服务、状态、导出、评测、测试脚本
└── docs/                        # 部署指南、评测说明、配图
```

</details>

## 文档

| 文档 | 说明 |
|------|------|
| [部署手册](docs/deploy.md) | 安装、配置、升级、备份，以及每个错误编号 |
| [基准评测](docs/benchmarks.md) | 运行 MatTools、SciAgentGym 和 ResearchClawBench（英文） |
| [许可说明](LICENSING.md) · [第三方声明](THIRD_PARTY_NOTICES.md) | 许可边界与上游声明（英文） |

## 贡献

欢迎贡献，尤其是**科学资产**。新能力就是新资产：一个 `asset.json` 清单（包含 id、类型、版本、依赖和权限），加上内容入口。

```
distribution/benchmark-minimal/assets/packs/<pack>/
├── skills/<name>/      asset.json · SKILL.md
├── roles/<name>/       asset.json · ROLE.md
├── tools/<name>/       asset.json · prompt.md · tool.py · input.schema.json
├── knowledge/<name>/   asset.json · KNOWLEDGE.md
├── data/<name>/        asset.json · DATA.md（只放引用，不放大文件）
└── workflows/<name>/   asset.json · workflow.json
```

提交资产时请附上验证证据和再分发许可。提交改动前，用 `matos assets validate` 校验资产，并运行 `bash scripts/matos-user-test-regression.sh`。报告问题时请提供源码版本、操作系统和 CPU、工具链版本，以及脱敏后的日志。详见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 相关项目

- [MatClaw](https://github.com/DingyangLyu/MatClaw)：我们之前的材料计算智能体。用自然语言描述任务，它会编写代码，在容器中运行 DFT、分子动力学或蒙特卡洛模拟，并返回结果。

## 致谢

MatOS 基于以下开源项目构建：

- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) — 智能体执行引擎（MIT）
- [OpenDesign](https://github.com/nexu-io/open-design) — 本界面所基于的浏览器工作区和守护进程（Apache-2.0）
- [Coze Studio](https://github.com/coze-dev/coze-studio) — 原生模块中的部分代码（包括图组件），保留其 Apache-2.0 版权头
- [MatterViz](https://github.com/janosh/matterviz) 和 [Svelte](https://svelte.dev) — 随附的晶体结构查看器（MIT）

工作流运行时借鉴了 [FireWorks](https://github.com/materialsproject/fireworks)、[AiiDA](https://github.com/aiidateam/aiida-core) 和 [atomate2](https://github.com/materialsproject/atomate2) 的动态工作流、错误处理和数据溯源设计。评测使用 [ResearchClawBench](https://arxiv.org/abs/2606.07591)、[MatTools](https://arxiv.org/abs/2505.10852) 和 [SciAgentGym](https://arxiv.org/abs/2602.12984)。

## 路线图

- [x] 分层资产图：共享、用户、项目三级作用域，本地 Git 验收与回滚
- [x] 有状态工作流：受检查的图修改、持久状态与后台执行
- [x] 证据驱动的资产演化：关闭、人工、自动三种审批模式和演化页面
- [x] 一键部署：系统检查和带编号的错误说明
- [ ] 把仪器和实验流程接入工作流运行时
- [ ] 打通计算证据与实验证据
- [ ] 跨项目的资产治理和科学可靠性评估
- [ ] 经过验证的 ARM64 与麒麟系统版本

## 引用

如果 MatOS 对你的研究有帮助，请引用技术报告：

```bibtex
@techreport{matos2026,
  title       = {{MatOS}: An Agent Operating System for Materials Research},
  author      = {{AI Materials Team}},
  institution = {Zhongguancun Academy and Zhongguancun Institute of Artificial Intelligence},
  address     = {Beijing, China},
  year        = {2026},
  month       = oct
}
```

联系邮箱：aimaterials@bza.edu.cn

## 许可证

MatOS 自有内容采用 [PolyForm Noncommercial License 1.0.0](LICENSE) 许可，可免费用于科研、教学等非商业用途，不允许商业使用；如有商用需求，请联系 aimaterials@bza.edu.cn。第三方组件保留各自的许可证，详见 [LICENSING.md](LICENSING.md)。
