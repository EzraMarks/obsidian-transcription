/**
 * Minimal Obsidian mock for running plugin code in Node.js / Vitest.
 * - requestUrl delegates to native fetch so real OpenAI calls work
 * - All Obsidian UI classes are lightweight stubs
 */

// ── requestUrl ────────────────────────────────────────────────────────────────
export async function requestUrl(options: {
    url: string;
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    contentType?: string;
}) {
    const method = options.method ?? "GET";
    const headers: Record<string, string> = {};
    if (options.contentType) headers["Content-Type"] = options.contentType;
    Object.assign(headers, options.headers ?? {});

    const response = await fetch(options.url, {
        method,
        headers,
        body: options.body,
    });

    const text = await response.text();
    let json: unknown;
    try {
        json = JSON.parse(text);
    } catch {
        /* not JSON */
    }

    return {
        status: response.status,
        text,
        json,
        headers: Object.fromEntries(response.headers.entries()),
        arrayBuffer: () => response.arrayBuffer(),
    };
}

// ── TFile / TFolder ───────────────────────────────────────────────────────────
export class TFile {
    name: string;
    basename: string;
    extension: string;
    stat: { mtime: number; ctime: number; size: number };
    parent: unknown = null;

    constructor(public path: string, extension?: string) {
        const lastSlash = path.lastIndexOf("/");
        this.name = lastSlash >= 0 ? path.slice(lastSlash + 1) : path;
        const dotIdx = this.name.lastIndexOf(".");
        if (dotIdx > 0) {
            this.extension = extension ?? this.name.slice(dotIdx + 1);
            this.basename = this.name.slice(0, dotIdx);
        } else {
            this.extension = extension ?? "";
            this.basename = this.name;
        }
        this.stat = { mtime: Date.now(), ctime: Date.now(), size: 0 };
    }
}

export class TFolder {
    children: unknown[] = [];
    constructor(public path: string, public name: string) {}
}

export class TAbstractFile {
    constructor(public path: string) {}
}

// ── Stub factory ──────────────────────────────────────────────────────────────
function makeStub(label: string) {
    return class {
        static __obsidianStub = label;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        constructor(..._args: any[]) {}
        open() {}
        close() {}
        onOpen() {}
        onClose() {}
    };
}

// ── UI stubs ──────────────────────────────────────────────────────────────────
export const App = makeStub("App");
export const Vault = makeStub("Vault");
export const Modal = makeStub("Modal");
export const Notice = makeStub("Notice");
export const Plugin = makeStub("Plugin");
export const ItemView = makeStub("ItemView");
export const MarkdownView = makeStub("MarkdownView");
export const Editor = makeStub("Editor");
export const Menu = makeStub("Menu");
export const FuzzySuggestModal = makeStub("FuzzySuggestModal");
export const TextComponent = makeStub("TextComponent");

export const Platform = { isMobile: false, isDesktop: true };

export class PluginSettingTab {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(..._args: any[]) {}
    display() {}
}

export class AbstractInputSuggest<T> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(..._args: any[]) {}
    getValue() { return ""; }
    setValue(_v: string) { return this; }
    close() {}
    getSuggestions(_q: string): T[] { return []; }
    renderSuggestion(_item: T, _el: unknown) {}
    selectSuggestion(_item: T) {}
}

export class Setting {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(..._args: any[]) {}
    setName() { return this; }
    setDesc() { return this; }
    setClass() { return this; }
    setHeading() { return this; }
    setTooltip() { return this; }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    addText(cb: (t: any) => void) {
        cb({ setPlaceholder: () => ({ setValue: () => ({ onChange: () => {} }) }), inputEl: {} });
        return this;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    addToggle(cb: (t: any) => void) {
        cb({ setValue: () => ({ onChange: () => {} }) });
        return this;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    addDropdown(cb: (t: any) => void) {
        cb({ addOption: () => ({ addOption: () => ({ setValue: () => ({ onChange: () => {} }) }) }) });
        return this;
    }
}

// ── Types used by backlinkEngine ──────────────────────────────────────────────
export type LinkCache = {
    link: string;
    original: string;
    position: { start: { line: number; col: number; offset: number }; end: { line: number; col: number; offset: number } };
};

export type FuzzyMatch<T> = { item: T; score: number; matches: [number, number][] };
