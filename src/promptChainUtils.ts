import yaml from "yaml";

export interface InputSource {
    name: string;
    type: "file_content" | "file_list";
    path: string;
}

export interface LlmPromptPart {
    role: "system" | "user" | "assistant";
    content: string;
}

export interface LlmChainStep {
    name: string;
    type: "llm";
    description: string;
    if?: string;
    model: LlmModel;
    prompt: LlmPromptPart[];
}

export interface LlmModel {
    name: string;
    temperature: number;
}

export interface HumanChainStep {
    name: string;
    type: "human";
    description: string;
    if?: string;
    prompt: string;
}

export interface TemplatingChainStep {
    name: string;
    type: "templating";
    description: string;
    if?: string;
    template: string;
}

export type ChainStep = LlmChainStep | HumanChainStep | TemplatingChainStep;

export interface PromptChainSpec {
    additional_inputs: InputSource[];
    steps: ChainStep[];
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
