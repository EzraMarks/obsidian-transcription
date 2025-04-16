import yaml from "yaml";

export interface ContextItem {
    name: string;
    type: "file_content" | "file_list";
    path: string;
}

export interface LlmPromptPart {
    role: "system" | "user" | "assistant";
    content: string;
}

export interface LlmChainStep {
    id: string;
    type: "llm";
    description: string;
    model: string;
    temperature: number;
    prompt: LlmPromptPart[];
}

export interface HumanChainStep {
    id: string;
    type: "human";
    description: string;
    if?: string;
    prompt: string;
}

export type ChainStep = LlmChainStep | HumanChainStep;

export interface PromptChainSpec {
    context: ContextItem[];
    chain: ChainStep[];
}

export function parsePromptChainSpecFile(fullText: string): PromptChainSpec {
    // Strip frontmatter
    const withoutFrontmatter = fullText.replace(/^---[\s\S]*?---/, "").trim();

    // Extract content inside ```yaml code block
    const match = withoutFrontmatter.match(/```yaml([\s\S]*?)```/);
    if (!match) {
        throw new Error("YAML code block not found");
    }

    const yamlContent = match[1].trim();
    const parsed = yaml.parse(yamlContent);
    return parsed;
}
