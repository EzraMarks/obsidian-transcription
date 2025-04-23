import yaml from "yaml";
import { TFile, TFolder, Vault } from "obsidian";

export type InputSource = FileContentInputSource | FileListInputSource;

export interface FileContentInputSource {
    name: string;
    type: "file_content";
    path: string;
}

export interface FileListInputSource {
    name: string;
    type: "file_list";
    path: string;
    frontmatterProperties: string[];
}

export interface LlmPromptPart {
    role: "system" | "user" | "assistant";
    content: string;
}

interface BaseChainStep {
    name: string;
    if?: string;
    description: string;
}

export interface LlmChainStep extends BaseChainStep {
    type: "llm";
    model: LlmModel;
    prompt: LlmPromptPart[];
}

export interface LlmModel {
    name: string;
    temperature: number;
}

export interface HumanChainStep extends BaseChainStep {
    type: "human";
    prompt: string;
}

export interface TemplatingChainStep extends BaseChainStep {
    type: "templating";
    template: string;
}

export interface AutoWikilinkChainStep extends BaseChainStep {
    type: "auto_wikilink";
    files: string[];
    input: string;
}

export type ChainStep = LlmChainStep | HumanChainStep | TemplatingChainStep | AutoWikilinkChainStep;

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
