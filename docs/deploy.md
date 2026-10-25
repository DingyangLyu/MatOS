# MatOS 部署手册

这份手册写给要在一台 Linux 机器上部署 MatOS 的人。照着第 2 节做就能装好；装的过程中出了问题，按屏幕上显示的编号（例如 `C12`、`I03`）到第 6 节查，或者按症状到第 7 节查。

MatOS 是单用户应用：一个实例给一个人用，数据只保存在这台机器上。部署不需要 root 权限，部署过程需要联网。

## 1. 开始之前

### 1.1 机器要求

| 项目 | 要求 | 说明 |
| --- | --- | --- |
| 操作系统 | Linux，glibc 2.28 或更高 | Ubuntu 20.04+、Debian 10+、RHEL/Rocky/Alma 8+ 都满足。 |
| CPU | x86_64 | ARM64（aarch64）见 [C02](#c02)。 |
| 内存 | 4 GB 以上 | 安装时要构建网页前端，内存太小构建会被系统终止。 |
| 磁盘 | 程序约 3 GB；数据目录另算 | 数据目录随项目和计算结果增长，建议放在空间大的磁盘上。 |
| 网络 | 能访问 npm 依赖源、Node/Bun 下载地址、DeepSeek API | 访问国外网站慢时可以用国内镜像（见 3.4）或代理（见 7.6）。 |
| 账户 | 普通用户即可 | 不需要 root。 |

### 1.2 需要提前装好的软件

大多数服务器已经自带。用下面的命令确认：

```bash
python3 --version   # 需要 3.9 或更高
git --version
gcc --version && g++ --version && make --version
```

缺哪个就按第 6 节对应编号处理：Python 见 [C04](#c04)，Git 见 [C05](#c05)，编译器和 make 见 [C06](#c06)。没有 root 权限时，可以请管理员安装，或者用 conda 装到自己的目录。

**不需要**提前装 Node.js 和 Bun：部署脚本发现系统里没有合适的版本时，会把 Node 24.18.0 和 Bun 1.3.14 下载到你自己的用户目录，并核对官方校验值。系统里原有的 Node、Bun 不受影响。

### 1.3 准备好这些东西

- **MatOS 源码**：从 <https://github.com/DingyangLyu/MatOS> 获取（见第 2 节）。
- **DeepSeek API Key**（可选）：在 <https://platform.deepseek.com> 创建。也可以部署完成后在网页里再填，第一次打开网页时就会提示你填。使用兼容网关的，准备好网关地址。

## 2. 快速部署

```bash
git clone https://github.com/DingyangLyu/MatOS.git
cd MatOS
./deploy.sh init     # 回答几个问题，生成配置文件 matos-deploy.conf
./deploy.sh          # 检查 → 安装 → 启动 → 验证，全部自动完成
```

`./deploy.sh init` 会依次问：数据目录、网页端口、后台端口、API Key（输入时不显示，可以直接回车跳过）、企业网关地址、是否开机自启、是否使用国内镜像。不确定的地方直接回车用默认值。

如果你是在脚本里或者没有交互终端的环境下部署，`./deploy.sh init` 会直接生成带注释的配置模板，用编辑器改好后再运行 `./deploy.sh` 即可。配置项的含义见第 3 节。

`./deploy.sh` 运行时分 5 步，每一步都会显示进度。网络正常时首次部署大约 4–10 分钟，大部分时间花在下载依赖和构建网页上；之后重新部署只需几十秒。成功时最后会看到：

```text
✓ MatOS 部署完成
  本机访问：http://127.0.0.1:17474/
  从你自己的电脑访问：在你的电脑上运行下面这行，然后打开 http://127.0.0.1:17474/
      ssh -N -L 17474:127.0.0.1:17474 alice@server01
  模型：已验证可用（deepseek-flash）
  数据目录：/home/alice/matos-data
  常用命令：./deploy.sh status | stop | start | restart | logs | check | report
  使用和排错手册：docs/deploy.md
```

### 2.1 打开网页

MatOS 只监听本机地址 127.0.0.1，不直接暴露到网络上。

- **在部署的这台机器上用浏览器**：直接打开 `http://127.0.0.1:17474/`。
- **从你自己的电脑访问服务器上的 MatOS**：在你的电脑上（Windows 用 PowerShell，macOS/Linux 用终端）运行部署结果里给出的 `ssh -N -L ...` 命令。这个窗口保持打开，然后在浏览器里打开 `http://127.0.0.1:17474/`。VS Code Remote-SSH、MobaXterm 等工具的"端口转发"功能也可以，转发 17474 端口即可。

### 2.2 第一次打开网页

第一次打开会看到欢迎页，其中有"连接模型"一栏：

- 部署时已经填过 Key 的，这里显示为"部署默认"，可以直接点"开始使用"。
- 显示"未配置"的，在这里填 DeepSeek API Key 并点保存。保存时系统会真实调用一次模型，看到"已验证"就可以用了。
- 以后想换 Key 或模型：右上角设置 → 设置 → 执行模式。

## 3. 配置文件 matos-deploy.conf

配置文件默认在程序目录里，文件权限会被设为 600（只有你自己能读）。改完配置后重新运行 `./deploy.sh` 就会生效。想把配置放在别处，用 `./deploy.sh --config /路径/matos-deploy.conf`。

### 3.1 基本项

| 配置项 | 默认值 | 说明 |
| --- | --- | --- |
| `state_dir` | `~/matos-data` | 数据目录：项目、对话、资产版本、运行记录都在这里。**不能**放在程序目录里面；升级或重装程序不会动它。 |
| `web_port` | `17474` | 网页端口。被占用时换一个，例如 18474。 |
| `daemon_port` | `17473` | 后台端口，不能和网页端口相同。 |

### 3.2 模型

| 配置项 | 默认值 | 说明 |
| --- | --- | --- |
| `deepseek_api_key` | 空 | 可以留空，在网页里填。填在这里时，部署脚本会把它写进 `env_file`。 |
| `deepseek_base_url` | 空 | 用 DeepSeek 官方接口时留空；用企业兼容网关时填网关地址。 |
| `model` | `deepseek-flash` | 默认模型。 |
| `env_file` | `~/.config/matos/matos.env` | 保存模型配置的文件，部署时自动写入，权限 600。里面你自己加的其他行不会被改动。 |

网页里填的 Key 优先于这里的 Key。

### 3.3 开机自启

| 取值 | 说明 |
| --- | --- |
| `none` | 默认。机器重启后需要手动运行 `./deploy.sh start`。 |
| `cron` | 推荐，不需要 root：在你的 crontab 里加一行 `@reboot`，开机后自动启动。 |
| `systemd-user` | 用 systemd 用户服务管理。注意：除非管理员执行过 `sudo loginctl enable-linger 你的用户名`，否则你退出登录后服务会停止，开机也不会自动启动。 |

改回 `none` 再运行 `./deploy.sh`，会删掉之前加的 cron 行或 systemd 用户服务。服务本身一直有守护进程：进程异常退出时会自动拉起，与这里的开机自启无关。

### 3.4 下载和镜像

| 配置项 | 默认值 | 说明 |
| --- | --- | --- |
| `toolchain_dir` | `~/.local/share/matos/toolchain` | 私有 Node 和 Bun 的存放位置。多个 MatOS 实例可以共用。 |
| `npm_registry` | 空（官方源） | 国内网络建议填 `https://registry.npmmirror.com` |
| `node_mirror` | 空（nodejs.org） | 国内网络建议填 `https://npmmirror.com/mirrors/node` |
| `bun_mirror` | 空（GitHub） | 国内网络建议填 `https://registry.npmmirror.com/-/binary/bun` |

`./deploy.sh init` 问"是否使用国内镜像"时回答 y，会自动填好这三项。无论用哪个来源，下载的 Node 和 Bun 都会和官方校验值比对。

### 3.5 科学计算环境（可选）

| 配置项 | 说明 |
| --- | --- |
| `toolchain_root` | 科学计算工具所在目录 |
| `conda_envs_path` | conda 环境目录 |
| `mlip_model_root` | 机器学习势模型目录 |

科学计算用的 Python 环境、数据和模型权重需要另外准备，可以用 `python3 scripts/matos-science-doctor.py --profile all` 检查它们是否齐全。

## 4. 部署脚本做了什么

| 步骤 | 做的事情 | 产生的文件 |
| --- | --- | --- |
| 1/5 系统检查 | 逐项检查第 6 节的 C01–C18，有"FAIL"就停下并给出处理方法 | 无 |
| 2/5 Node 和 Bun | 系统里没有 Node 24 / Bun 1.3.14 时下载私有版本并核对校验值 | `toolchain_dir` 下的 Node 和 Bun |
| 3/5 安装程序 | 运行 `scripts/matos-setup.sh`：安装依赖、检查原生组件、校验资产、构建网页。当前版本已经装过就跳过 | 程序目录下的 `node_modules`、构建产物；日志在 `.matos/deploy/setup-*.log` |
| 4/5 启动 | 写入 `env_file`，启动服务，等待健康检查通过 | `state_dir` |
| 5/5 验证 | 有 Key 时通过运行中的服务真实调用一次模型；按 `autostart` 设置开机自启 | crontab 中的一行，或 `~/.config/systemd/user/matos-*.service` |

可以随时重复运行 `./deploy.sh`：已经完成的部分会跳过，配置有变化就按新配置重启服务。重新部署前如果服务在运行，交互模式下会先问你，因为重启会中断正在运行的任务；加 `--yes` 不再询问。需要强制重新安装依赖和重新构建时加 `--reinstall`。

每次部署的完整输出保存在 `.matos/deploy/deploy-*.log`，里面的密钥已打码。

## 5. 日常使用和维护

### 5.1 常用命令

在程序目录下运行：

| 命令 | 作用 |
| --- | --- |
| `./deploy.sh status` | 查看是否在运行、是否健康 |
| `./deploy.sh start` / `stop` / `restart` | 启动、停止、重启 |
| `./deploy.sh logs` | 显示服务日志的最后几十行（`--lines 200` 看更多） |
| `./deploy.sh check` | 只做系统检查，不安装、不重启 |
| `./deploy.sh report` | 打包诊断信息，发给帮你排查问题的人 |
| `./deploy.sh` | 按当前配置重新部署 |
| `./deploy.sh uninstall` | 停止服务并删除开机自启（文件和数据都保留） |

### 5.2 修改配置

改 `matos-deploy.conf`，再运行 `./deploy.sh`。例如换端口、换模型地址、打开开机自启都是这样。

### 5.3 升级到新版本

数据目录和程序目录是分开的，升级不会动数据。

```bash
git clone https://github.com/DingyangLyu/MatOS.git /另一个目录/MatOS
cp 旧程序目录/matos-deploy.conf /另一个目录/MatOS/
cd /另一个目录/MatOS
./deploy.sh --yes
```

新目录的部署会：停掉旧版本的服务；把数据目录切换到新版本自带的基础资产包（切换前会检查你自己的资产和项目资产与新版本是否兼容，不兼容就停下并报 [R02](#r02)，什么都不改）；用同一个数据目录启动新版本；把开机自启指向新目录。屏幕上会显示"数据目录绑定的是另一个程序目录的资产包，正在校验并切换到当前版本"。确认新版本正常后，再删除旧程序目录。

### 5.4 备份和迁移

先停止服务，再导出数据目录：

```bash
./deploy.sh stop
python3 scripts/matos-state.py export --state-dir ~/matos-data --output ~/matos-backup.tar.gz
```

在新机器上按第 2 节部署好以后，先 `./deploy.sh stop`，再用 `python3 scripts/matos-state.py import` 导入到新的数据目录，并把 `state_dir` 改成那个目录后重新运行 `./deploy.sh`。备份里有私人工作数据，请妥善保管。

### 5.5 卸载

```bash
./deploy.sh uninstall
```

它会停止服务、删除部署脚本加的 cron 行或 systemd 用户服务，然后列出剩下需要你手动删除的位置：程序目录、`toolchain_dir`（其他实例可能也在用）、`env_file`、数据目录。数据目录里是你的项目和对话，确定不要了再删。

## 6. 检查项和错误编号

部署输出里的每一行都带编号。`[ OK ]` 表示通过，`[WARN]` 表示可以继续但需要注意，`[FAIL]` 表示必须先处理。

<a id="c01"></a>
### C01 操作系统

只支持 Linux。macOS 和 Windows 不能直接部署；Windows 可以在 WSL2 的 Ubuntu 里部署。

<a id="c02"></a>
### C02 CPU 架构

ARM64 显示 WARN，可以继续部署。CPU 不支持 AVX2 时，会自动改用 Bun 的 baseline 版本。

<a id="c03"></a>
### C03 glibc

Node 24 需要 glibc 2.28 或更高。用 `ldd --version` 查看。CentOS 7（glibc 2.17）这类老系统无法运行，需要换用更新的发行版。安装日志里出现 `GLIBC_2.xx not found` 也是这个原因。

<a id="c04"></a>
### C04 Python

需要 Python 3.9 或更高。没有 root：用 Miniconda 装到自己的目录（`conda create -n py311 python=3.11`，激活后再运行）。有管理员：Ubuntu/Debian 用 `sudo apt install python3`，RHEL/Rocky 用 `sudo dnf install python3`。

<a id="c05"></a>
### C05 Git

Ubuntu/Debian：`sudo apt install git`；RHEL/Rocky/麒麟：`sudo yum install git`；没有 root：`conda install -c conda-forge git`。

<a id="c06"></a>
### C06 C/C++ 编译器和 make

安装时要编译几个原生组件（终端、SQLite 等），需要 gcc、g++ 和 make。

- Ubuntu/Debian：`sudo apt install build-essential`
- RHEL/Rocky/麒麟：`sudo yum groupinstall "Development Tools"`
- 没有 root：`conda install -c conda-forge gcc gxx make`，激活该 conda 环境后再运行 `./deploy.sh`

<a id="c07"></a>
### C07 Node.js 24 / <a id="c08"></a>C08 Bun 1.3.14

WARN 表示系统里没有合适的版本，部署时会自动下载到 `toolchain_dir`，无需处理。下载失败见 [I01](#i01)。

<a id="c09"></a>
### C09 程序目录磁盘空间 / <a id="c10"></a>C10 数据目录磁盘空间

安装大约占用 3 GB。数据目录建议至少 2 GB 可用空间，并随使用增长。用 `df -h 目录` 查看剩余空间。数据目录不够大时，把 `state_dir` 改到大容量磁盘上。

<a id="c11"></a>
### C11 内存

构建网页需要 2–4 GB 内存。内存不足时安装日志里会出现 `Killed` 或 `JavaScript heap out of memory`。先关闭其他占内存的程序再试，或换内存更大的机器。

<a id="c12"></a>
### C12 端口

端口被其他程序占用。用 `ss -ltnp | grep :17474` 看是谁占用，或者直接在配置里换一个端口。如果显示"被本实例使用"，说明 MatOS 已经在用这个端口，重新部署时会自动重启，不用处理。

<a id="c13"></a>
### C13 npm 依赖源 / <a id="c14"></a>C14 Node 和 Bun 下载源

访问不到依赖源或下载地址。先确认能上网；需要代理时，先 `export https_proxy=http://代理地址:端口` 再运行（见 [7.6](#76-需要通过代理上网)）；国内网络建议改用 npmmirror 镜像（见 3.4）。

<a id="c15"></a>
### C15 模型服务

服务器访问不到模型接口。只要能连上（哪怕返回 401），检查就算通过。连不上时检查网络和代理；用企业网关时检查 `deepseek_base_url` 是否写对。

<a id="c16"></a>
### C16 API Key

- **未填写（WARN）**：可以继续，部署完成后在网页里填。
- **无效（FAIL，401）**：Key 复制错了或已被删除，到 DeepSeek 平台重新复制。
- **余额不足（WARN）**：Key 有效，但账户余额已用完（屏幕上会显示当前余额）。部署可以继续，充值后才能对话。
- 使用企业网关时，部署前不预先检查 Key，部署结束时通过服务实际验证。

<a id="c17"></a>
### C17 开机自启

- `systemctl --user` 不可用：很多服务器的 SSH 会话没有用户级 systemd。改用 `autostart = cron` 即可。
- 找不到 `crontab`：请管理员安装 cron（cronie），或使用 `autostart = none`，重启后手动 `./deploy.sh start`。Docker 等容器里通常没有 cron，也没有 systemd，只能用 `none`，由容器自身的重启策略负责。

<a id="c18"></a>
### C18 运行账户

用 root 运行会显示 WARN。可以运行，但建议新建一个普通账户专门运行 MatOS。

<a id="i01"></a>
### I01 下载失败

下载 Node 或 Bun 时网络中断或超时（会自动重试 3 次）。检查网络和代理，或改用国内镜像，然后重新运行 `./deploy.sh`。

<a id="i02"></a>
### I02 校验失败

下载的文件和官方校验值不一致，通常是下载不完整或网络被篡改。删除 `toolchain_dir/downloads` 目录后重新运行。反复出现时换一个下载源。

<a id="i03"></a>
### I03 安装依赖时网络出错

日志里有 `ETIMEDOUT`、`ECONNRESET`、`ENOTFOUND`、`fetch failed` 等。处理方法和 [C13](#c13) 相同：配置代理或改用 npmmirror 镜像，然后重新运行 `./deploy.sh`（已下载的依赖会复用）。

<a id="i04"></a>
### I04 原生组件编译失败

日志里有 `gyp ERR`、`make: ***`、`g++: not found` 等。按 [C06](#c06) 装好编译器后重新运行；还不行时加 `--reinstall`。

<a id="i05"></a>
### I05 磁盘已满

日志里有 `ENOSPC` 或 `No space left on device`。清理磁盘后重新运行。

<a id="i06"></a>
### I06 其他安装错误

脚本没认出来的错误。屏幕上会显示日志最后 30 行和完整日志的位置（`.matos/deploy/setup-*.log`）。需要帮助时运行 `./deploy.sh report`，在 GitHub 提 issue 时附上生成的诊断包。

<a id="r01"></a>
### R01 服务没有正常启动

服务启动后 5 分钟内没有通过健康检查。屏幕上会接着显示服务日志。常见原因：

- 端口刚被别的程序占用：换端口后重新部署。
- 上次安装中途被打断：运行 `./deploy.sh --reinstall`。
- 数据目录属于另一套资产配置（日志里有 `bound to another asset profile`）：换一个新的 `state_dir`。

<a id="r02"></a>
### R02 切换资产包失败

只在把新版本部署到新目录、沿用旧数据目录时出现。可能是新版本的基础资产和你已有的资产不兼容，也可能数据目录正在被另一个服务使用。这一步失败时原来的绑定不会改动，旧版本照常可用：回到旧程序目录运行 `./deploy.sh start` 即可。需要帮助时，在 GitHub 提 issue 并附上屏幕上的报错和 `./deploy.sh report` 的结果。

<a id="r03"></a>
### R03 模型验证失败

服务已经正常运行，但用当前 Key 调用模型失败。部署结果会用文字说明原因，例如"余额不足（HTTP 402）"或"Key 无效（HTTP 401）"；超时一般是网络不通。改好 Key 后在网页 设置 → 执行模式 里重新保存即可，不需要重新部署。

<a id="a01"></a>
### A01 开机自启设置失败

服务本身已经在运行，只是开机自启没有设置成功。按屏幕上的报错处理，或者改用 `autostart = none`。

## 7. 常见问题（按症状查）

### 7.1 浏览器打不开页面

1. 在服务器上运行 `./deploy.sh status`，确认显示"运行中，健康"。
2. 不是在服务器本机打开的话，确认 SSH 隧道那个窗口还开着，并且两边端口号一致。
3. 运行 `./deploy.sh logs` 看有没有报错。

### 7.2 对话时提示"还没有配置模型 API Key"

在网页 设置 → 执行模式 里填写 Key 并保存。

### 7.3 对话时提示认证失败、余额不足或模型服务暂时不可用

到 设置 → 执行模式 点"测试"，看具体原因：Key 无效就重新填，余额不足就充值，网络问题见 7.6。

### 7.4 服务器重启后打不开了

没有设置开机自启时需要手动启动：`./deploy.sh start`。想自动启动，把 `autostart` 改成 `cron` 后重新运行 `./deploy.sh`。

### 7.5 `./deploy.sh status` 一直显示"正在恢复"

服务进程反复启动失败。运行 `./deploy.sh logs` 查看原因，最常见的是端口被占或磁盘满。处理后运行 `./deploy.sh restart`。

### 7.6 需要通过代理上网

先在当前终端设置代理，再运行部署：

```bash
export https_proxy=http://代理地址:端口 http_proxy=http://代理地址:端口
./deploy.sh
```

服务启动后访问模型也需要代理时，在同一个终端里运行 `./deploy.sh restart`，让服务继承代理设置。设置了 `autostart = cron` 的，开机自启时不带代理，可以在 `env_file` 里加 `HTTPS_PROXY=...` 一行。

### 7.7 下载或安装特别慢

国内网络建议把 3.4 节的三个镜像都填上。首次安装需要下载几百 MB 依赖，之后重新部署会复用。

### 7.8 一台机器上部署多个实例

每个实例用不同的程序目录（或同一程序目录配多个配置文件）、不同的 `state_dir`、不同的端口：

```bash
./deploy.sh --config ~/matos-b.conf
```

`toolchain_dir` 可以共用。

## 8. 日志位置和求助

| 内容 | 位置 |
| --- | --- |
| 每次部署的输出 | 程序目录 `.matos/deploy/deploy-*.log` |
| 安装依赖和构建 | 程序目录 `.matos/deploy/setup-*.log` |
| 服务守护进程 | `state_dir/.service/supervisor.log`、`launcher.log` |
| 后台和网页进程 | `state_dir/control/matos-*/logs/daemon/latest.log`、`.../web/latest.log` |

需要别人帮忙时，运行：

```bash
./deploy.sh report
```

它会生成 `.matos/deploy/report-时间.tar.gz`，里面包括：系统检查结果、服务状态、软件版本、配置（Key 已打码）以及上面各个日志的最后 400 行（密钥已打码）。发出去之前可以先解压看一遍。
