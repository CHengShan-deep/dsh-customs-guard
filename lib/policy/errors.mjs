/**
 * Error and reason codes shared by gate, house and broker.
 * Keep this file dependency-free: it is imported by the hook path.
 */

export const PROTOCOL_VERSION = 'cc-customs/1';

export const ERR = Object.freeze({
  DENIED: 'CUSTOMS_DENIED',
  ASK_UNATTENDED: 'CUSTOMS_ASK_UNATTENDED',
  BAD_PATH: 'CUSTOMS_BAD_PATH',
  NO_SHELL: 'CUSTOMS_NO_SHELL',
  TIMEOUT: 'CUSTOMS_TIMEOUT',
  NO_TTY: 'CUSTOMS_NO_TTY',
  SERVICE_DOWN: 'CUSTOMS_SERVICE_DOWN',
  UNAUTHORIZED: 'CUSTOMS_UNAUTHORIZED',
  UNSUPPORTED: 'CUSTOMS_UNSUPPORTED_FEATURE',
  BAD_REQUEST: 'CUSTOMS_BAD_REQUEST'
});

export const RISK = Object.freeze({
  NONE: 'none',
  SCOPED: 'scoped',
  BROAD: 'broad',
  IRREVERSIBLE: 'irreversible',
  UNKNOWN: 'unknown'
});

const RISK_ORDER = { none: 0, scoped: 1, broad: 2, irreversible: 3, unknown: 1.5 };

/** Higher-priority risk wins. unknown sits between scoped and broad. */
export function worseRisk(a, b) {
  return (RISK_ORDER[b] ?? 0) > (RISK_ORDER[a] ?? 0) ? b : a;
}

export const REASON = Object.freeze({
  READ_ONLY: 'READ_ONLY',
  SCOPED_WRITE: 'SCOPED_WRITE',
  SCOPED_DELETE: 'SCOPED_DELETE',
  BUILD_SCRIPT: 'BUILD_SCRIPT',
  OUTSIDE_SCOPE: 'OUTSIDE_SCOPE',
  PROTECTED_PATH: 'PROTECTED_PATH',
  DESTRUCTIVE_ROOT: 'DESTRUCTIVE_ROOT',
  GIT_DESTRUCTIVE: 'GIT_DESTRUCTIVE',
  FORCE_PUSH: 'FORCE_PUSH',
  PUBLISH: 'PUBLISH',
  PERMISSION_CHANGE: 'PERMISSION_CHANGE',
  DISK_OPERATION: 'DISK_OPERATION',
  SYSTEM_MODIFICATION: 'SYSTEM_MODIFICATION',
  REMOTE_FETCH_EXEC: 'REMOTE_FETCH_EXEC',
  DYNAMIC_EXECUTION: 'DYNAMIC_EXECUTION',
  ENCODED_COMMAND: 'ENCODED_COMMAND',
  INTERACTIVE_SHELL: 'INTERACTIVE_SHELL',
  UNPARSEABLE: 'UNPARSEABLE',
  MALFORMED_COMMAND: 'MALFORMED_COMMAND',
  UNCLASSIFIED: 'UNCLASSIFIED',
  NATIVE_SHELL_DISABLED: 'NATIVE_SHELL_DISABLED'
});

/** Short Chinese one-liners. Never interpolate user data into these. */
export const EXPLAIN = Object.freeze({
  READ_ONLY: '只读命令，无持久化副作用。',
  SCOPED_WRITE: '只写声明目录内，且可回滚。',
  SCOPED_DELETE: '删除范围限于工作目录内。',
  BUILD_SCRIPT: '构建/测试脚本，可能执行任意代码，按工作目录内处理。',
  OUTSIDE_SCOPE: '目标超出声明工作目录。',
  PROTECTED_PATH: '目标位于受保护路径。',
  DESTRUCTIVE_ROOT: '目标覆盖工作目录本身、家目录或根目录。',
  GIT_DESTRUCTIVE: '会丢弃未提交的改动。',
  FORCE_PUSH: '会改写远端历史。',
  PUBLISH: '会向外部发布产物。',
  PERMISSION_CHANGE: '会修改文件权限。',
  DISK_OPERATION: '会直接操作磁盘。',
  SYSTEM_MODIFICATION: '会修改系统服务、注册表或计划任务。',
  REMOTE_FETCH_EXEC: '会下载并执行远程代码。',
  DYNAMIC_EXECUTION: '动态构造并执行代码，无法静态判定。',
  ENCODED_COMMAND: '编码命令，无法静态判定内容。',
  INTERACTIVE_SHELL: '交互式解释器，审核只能覆盖启动动作。',
  UNPARSEABLE: '命令无法解析。',
  MALFORMED_COMMAND: '命令语法不完整或缺少必需参数，实际行为无法确定。',
  UNCLASSIFIED: '规则无法证明其安全性。',
  NATIVE_SHELL_DISABLED: '原生 Bash/PowerShell 已禁用；请改用 mcp__customs__Bash 或 mcp__customs__PowerShell。'
});

export function explain(code) {
  return EXPLAIN[code] ?? '未分类。';
}
