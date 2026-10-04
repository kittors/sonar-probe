import type { ReactNode } from 'react';
import { useAuth } from '../lib/auth';
import type { Capability } from '../lib/permissions';
import {
  IconBadgeCheck,
  IconDashboard,
  IconEye,
  IconFileText,
  IconGauge,
  IconKey,
  IconScan,
  IconSettings,
  IconShield,
  IconTerminal,
  IconUser,
  IconUsers,
} from './icons';

/**
 * 导航结构。页内标签页、命令面板都从这一份取。
 *
 * 之前 SSH 和管理后台各自在页面里维护一份标签列表，命令面板要再抄一份的话，
 * 加一个分区就得改两处 —— 漏改一处，就会出现面板里搜得到、页面里点不开的入口。
 */

type IconCmp = (p: { size?: number }) => ReactNode;

export interface Section<T extends string> {
  tab: T;
  label: string;
  /** 看得到这一项需要的能力。服务端的接口另有一道同样的校验，这里只决定显不显示 */
  cap: Capability;
  icon: IconCmp;
  /** 页头那一句说明 */
  description: string;
  /** 命令面板里的同义词 */
  keywords?: string;
}

export type SshTab = 'access' | 'keys' | 'grants' | 'drift';

export const SSH_SECTIONS: Array<Section<SshTab>> = [
  {
    tab: 'access',
    label: '连接方式',
    cap: 'ssh:view',
    icon: IconTerminal,
    description: '每台机器的别名、地址与 host key，可以生成一份直接放进 ~/.ssh/config 的配置。',
    keywords: 'ssh config 别名 怎么连 host',
  },
  {
    tab: 'keys',
    label: '我的公钥',
    cap: 'ssh:keys',
    icon: IconKey,
    description: '登记你自己的公钥。私钥永远只留在你的电脑上，面板只分发公钥。',
    keywords: 'key pub 钥匙 github',
  },
  {
    tab: 'grants',
    label: '授权',
    cap: 'ssh:view',
    icon: IconBadgeCheck,
    description: '哪把钥匙开哪台机器的哪个账号。状态以机器实况为准，不以命令是否发出为准。',
    keywords: 'grant 审批 撤销',
  },
  {
    tab: 'drift',
    label: '密钥实况',
    cap: 'ssh:audit',
    icon: IconScan,
    description: '对账面板记录和机器上实际存在的 authorized_keys，找出来路不明的钥匙。',
    keywords: 'drift authorized_keys 漂移 对账',
  },
];

export type AdminTab = 'users' | 'roles' | 'online' | 'audit' | 'traffic' | 'settings';

export const ADMIN_SECTIONS: Array<Section<AdminTab>> = [
  {
    tab: 'users',
    label: '用户与权限',
    cap: 'user:view',
    icon: IconUsers,
    description: '账号、角色，以及单独授予或收回的能力。',
    keywords: 'user 账号 权限',
  },
  // 角色是"一次改一批人"的东西，紧挨着用户放，但排在后面 ——
  // 日常要动的是某个人的权限，改角色是低频且影响面更大的操作
  {
    tab: 'roles',
    label: '角色',
    cap: 'user:view',
    icon: IconShield,
    description: '一个角色就是一组能力。改动会立刻推给在线的人，不用重新登录。',
    keywords: 'role 能力',
  },
  {
    tab: 'online',
    label: '在线与访客',
    cap: 'audit:view',
    icon: IconEye,
    description: '此刻谁在看面板、在看哪一页，以及访客身份的来去。',
    keywords: 'online 会话 访客 下线',
  },
  {
    tab: 'audit',
    label: '审计日志',
    cap: 'audit:view',
    icon: IconFileText,
    description: '登录、改权限、封禁、授权……每一次操作都留痕。',
    keywords: 'audit log 日志 记录',
  },
  {
    tab: 'traffic',
    label: '流量阈值',
    cap: 'alert:view',
    icon: IconGauge,
    description: '按配额百分比或绝对量设置流量告警，看哪台机器会先撞线。',
    keywords: 'alert 告警 阈值 配额',
  },
  // 放在最后：它管的是全站口径，改的频率远低于前面几项日常要看的东西
  {
    tab: 'settings',
    label: '通用设置',
    cap: 'settings:view',
    icon: IconSettings,
    description: '流量口径、时区、汇率与数据保留 —— 全站数字按这里的规则计算。',
    keywords: 'settings 时区 汇率 口径 保留',
  },
];

export interface NavItem {
  key: string;
  label: string;
  to: string;
  icon: IconCmp;
  keywords?: string;
}

export interface NavGroup {
  key: string;
  label: string;
  items: NavItem[];
}

/** 当前身份能看到的页面。没权限的入口直接不出现，不做"点了再说没权限"。 */
export function useNavGroups(): NavGroup[] {
  const { me, can } = useAuth();

  const groups: NavGroup[] = [
    {
      key: 'monitor',
      label: '监控',
      items: [
        {
          key: 'overview',
          label: '机器概览',
          to: '/',
          icon: IconDashboard,
          keywords: 'overview 首页 机器 服务器',
        },
      ],
    },
  ];

  const ssh = SSH_SECTIONS.filter((s) => can(s.cap));
  if (ssh.length > 0) {
    groups.push({
      key: 'ssh',
      label: 'SSH',
      items: ssh.map((s) => ({
        key: `ssh-${s.tab}`,
        label: s.label,
        to: `/ssh/${s.tab}`,
        icon: s.icon,
        keywords: s.keywords,
      })),
    });
  }

  const admin = ADMIN_SECTIONS.filter((s) => can(s.cap));
  if (admin.length > 0) {
    groups.push({
      key: 'admin',
      label: '管理',
      items: admin.map((s) => ({
        key: `admin-${s.tab}`,
        label: s.label,
        to: `/admin/${s.tab}`,
        icon: s.icon,
        keywords: s.keywords,
      })),
    });
  }

  // 访客没有可维护的凭据，个人设置对他是一个空页面
  if (me && me.kind !== 'guest') {
    groups.push({
      key: 'account',
      label: '账户',
      items: [
        {
          key: 'settings',
          label: '个人设置',
          to: '/settings',
          icon: IconUser,
          keywords: 'profile 密码 github 账号',
        },
      ],
    });
  }

  return groups;
}
