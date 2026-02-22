// --- Pipeline Definition ---

export interface PipelineDefinition {
    inputs: PipelineInputSource[];
    steps: PipelineStep[];
}

// --- Pipeline Step Types ---

export type PipelineStep =
    | AudioTranscriptionPipelineStep
    | LlmPipelineStep
    | HumanPipelineStep
    | TemplatingPipelineStep
    | AutoWikilinkPipelineStep;

export interface AudioTranscriptionPipelineStep extends BasePipelineStep {
    type: "audio_transcription";
    file: string;
}

export interface LlmPipelineStep extends BasePipelineStep {
    type: "llm";
    model: LlmModel;
    prompt: LlmPromptPart[];
}

export interface LlmPromptPart {
    role: "system" | "user" | "assistant";
    content: string;
}

export interface LlmModel {
    name: string;
    temperature: number;
}

export interface HumanPipelineStep extends BasePipelineStep {
    type: "human";
    prompt: string;
}

export interface TemplatingPipelineStep extends BasePipelineStep {
    type: "templating";
    template: string;
}

export interface AutoWikilinkEntityType {
    type: string;
    description?: string;
    files: string[];
}

export interface AutoWikilinkPipelineStep extends BasePipelineStep {
    type: "auto_wikilink";
    entity_types: AutoWikilinkEntityType[];
    input: string;
}

export interface BasePipelineStep {
    type: string;
    name: string;
    if?: string;
    description: string;
}

// --- Input Sources ---

export type PipelineInputSource = FileContentInputSource | FileListInputSource;

export interface FileContentInputSource {
    name: string;
    type: "file_content";
    file: string;
}

// TODO: Haven't thought about this interface as much - should folder support globs?
export interface FileListInputSource {
    name: string;
    type: "file_list";
    folder: string;
    frontmatterProperties: string[];
}
