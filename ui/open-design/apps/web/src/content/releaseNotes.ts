import type { Locale } from '../i18n';

export type ReleaseNoteSectionKind = 'added' | 'improved' | 'fixed';

export interface LocalizedReleaseText {
  en: string;
  zhCN: string;
}

export interface ReleaseNoteSection {
  kind: ReleaseNoteSectionKind;
  title: LocalizedReleaseText;
  items: LocalizedReleaseText[];
}

export interface ReleaseNote {
  id: string;
  version: string;
  channel: 'stable' | 'main';
  publishedAt: string;
  commit?: string;
  commitUrl?: string;
  latest?: boolean;
  title: LocalizedReleaseText;
  summary: LocalizedReleaseText;
  tags: string[];
  sections: ReleaseNoteSection[];
}

export function releaseText(text: LocalizedReleaseText, locale: Locale): string {
  return locale === 'zh-CN' || locale === 'zh-TW' ? text.zhCN : text.en;
}

// Add a new entry at the top for each release; the UI handles ordering,
// anchors, filters, locale selection, and responsive presentation.
export const MATOS_RELEASE_NOTES: ReleaseNote[] = [
  {
    id: '2026-10-25-matos-1-0',
    version: '1.0.0',
    channel: 'stable',
    publishedAt: '2026-10-25T00:00:00Z',
    latest: true,
    title: {
      en: 'MatOS 1.0',
      zhCN: 'MatOS 1.0',
    },
    summary: {
      en: 'The first public release: a single-user workspace for materials research agents, built on scientific assets, stateful workflows and evidence-driven evolution.',
      zhCN: '首个公开版本：面向材料科研智能体的单用户工作区，以科学资产、有状态工作流和证据驱动的演化为核心。',
    },
    tags: ['Runtime', 'Assets', 'Workflows', 'Evolution', 'Benchmarks'],
    sections: [
      {
        kind: 'added',
        title: { en: 'Scientific workspace', zhCN: '科学工作区' },
        items: [
          {
            en: 'Projects, persistent conversations, files, previews, a terminal and a crystal-structure viewer in one workspace.',
            zhCN: '项目、持久对话、文件、预览、终端和晶体结构查看器集中在同一个工作区。',
          },
          {
            en: 'Versioned scientific assets with dependencies and shared, user and project scopes.',
            zhCN: '带依赖关系的版本化科学资产，支持共享、用户和项目三级作用域。',
          },
          {
            en: 'Stateful workflows with execution evidence, approvals, cancellation and recovery.',
            zhCN: '有状态工作流，支持执行证据、审批、取消和恢复。',
          },
        ],
      },
      {
        kind: 'added',
        title: { en: 'Agent engine and evolution', zhCN: '智能体引擎与演化' },
        items: [
          {
            en: 'DeepSeek Harness runs every conversation, workflow node and evolution role, with a DeepSeek API key or a compatible base URL.',
            zhCN: '所有对话、工作流节点和演化角色都由 DeepSeek Harness 执行，支持 DeepSeek API key 或兼容的 base URL。',
          },
          {
            en: 'Evidence-driven asset evolution with structural checks and semantic review, and off, manual or automatic approval on the Evolution page.',
            zhCN: '证据驱动的资产演化，包含结构检查和语义评审，可在演化页面设置关闭、人工或自动审批。',
          },
        ],
      },
      {
        kind: 'added',
        title: { en: 'Deployment and benchmarks', zhCN: '部署与评测' },
        items: [
          {
            en: './deploy.sh checks the machine, installs, starts and verifies the model in one command.',
            zhCN: './deploy.sh 一条命令完成系统检查、安装、启动和模型验证。',
          },
          {
            en: 'Preparation, run and scoring entrypoints for MatTools, SciAgentGym and ResearchClawBench.',
            zhCN: 'MatTools、SciAgentGym 和 ResearchClawBench 的准备、运行与评分入口。',
          },
        ],
      },
    ],
  },
];
