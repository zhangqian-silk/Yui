export type TopicDefinition = {
  id: string;
  name: string;
  description: string;
};

export type CustomTopic = TopicDefinition & {
  createdBy: "user" | "operator" | "leader";
  createdAt: string;
};

export type TaskTopics = {
  schemaVersion: 1;
  customTopics: CustomTopic[];
};

export const BUILTIN_TOPICS: readonly TopicDefinition[] = [
  { id: "requirements", name: "需求", description: "目标、范围与验收条件" },
  { id: "architecture", name: "架构", description: "系统边界、组件关系与技术决策" },
  { id: "ui", name: "UI", description: "界面、交互与用户体验" },
  { id: "implementation", name: "实现", description: "编码与功能交付" },
  { id: "testing", name: "测试", description: "验证、回归与质量保障" },
  { id: "deployment", name: "部署", description: "发布、环境与交付流程" },
  { id: "operations", name: "运行", description: "监控、维护与故障处理" },
  { id: "security", name: "安全", description: "权限、风险与安全审查" }
];

export function emptyTaskTopics(): TaskTopics {
  return { schemaVersion: 1, customTopics: [] };
}

export function createCustomTopic(
  input: Omit<CustomTopic, "createdAt">,
  now: Date
): CustomTopic {
  const id = input.id.trim();
  const name = input.name.trim();
  const description = input.description.trim();

  if (id.length === 0) {
    throw new Error("Topic id is required.");
  }

  if (name.length === 0) {
    throw new Error("Topic name is required.");
  }

  if (description.length === 0) {
    throw new Error("Topic description is required.");
  }

  return {
    id,
    name,
    description,
    createdBy: input.createdBy,
    createdAt: now.toISOString()
  };
}

export function usesConventionalTopicId(id: string): boolean {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id);
}
