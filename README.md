# Obsidian Transcription

Automatically transcribe audio files and run customizable AI-powered steps—cleanup, formatting, summarization, and auto-linking—to generate clean, structured Markdown notes.

## Contact

Contact me by [email](mailto:ezra@ezramarks.com) if you have any comments, issues, or suggestions.

## Configuration

Create a YAML spec (e.g. `transcription.yaml`) in your vault:

```yaml
additional_inputs:
    - name: folder_files
      type: file_list
      folder: /
      frontmatterProperties:
          - aliases

    - name: readme_text
      type: file_content
      file: Other File.md

steps:
    - name: summarize
      type: llm
      description: Summarize user text
      model:
          name: gpt-4o
          temperature: 0.3
      prompt:
          - role: system
            content: >
                You are a helpful assistant that summarizes text.
          - role: user
            content: >
                Summarize the following: {{ input }}

    - name: identify_gaps
      type: llm
      description: Determine missing information
      model:
          name: gpt-4o
          temperature: 0.2
      prompt:
          - role: system
            content: >
                Ask one meaningful question
          - role: user
            content: >
                Given the summary: "{{ summarize }}", ask one meaningful question.

    - name: needs_clarification
      type: llm
      description: Decide whether clarification is needed
      model:
          name: gpt-4o
          temperature: 0
      prompt:
          - role: system
            content: >
                You decide if any questions identified are meaningful. You must either respond 'Yes' or 'No'.
          - role: user
            content: >
                Just say "Yes"

    - name: request_clarification
      type: human
      description: Ask user for clarification
      if: "{{ needs_clarification == 'Yes' }}"
      prompt: >
          Please answer these clarifying questions: {{ identify_gaps }}

    - name: generate_response
      type: llm
      description: Generate final reply
      model:
          name: gpt-4o
          temperature: 0.7
      prompt:
          - role: system
            content: >
                You are a terse chatbot.
          - role: user
            content: >
                Write a short reply using: Summary: {{ summarize }} Clarification: {{ request_clarification | default("N/A") }}

    - name: manual_string_template
      type: templating
      description: Apply string template to generate a final formatted output
      template: |
          Final output:
          - Summary: {{ summarize }}
          - Gaps: {{ folder_files }}
          - Clarification: {{ request_clarification | default("No clarification needed") }}
          - ... okay then! {{ identify_gaps }}
          - This: {{ needs_clarification }}
```

### Example Step: Auto-Wikilink

The auto_wikilink is one of many step types you can use, but it is specialized to create Obsidian wikilinks to known entities in the input text.

```yaml
steps:
    - name: make_links
      type: auto_wikilink
      description: Link entities in text
      files:
          - Tags/**/*
          - General/Projects/*
      input: "{{ cleaned_text }}"
```

This will scan your `Tags/` and `General/Projects/` folders and convert recognized terms into Obsidian links.

This step makes use of both the "aliases" frontmatter property, as well as the "misspellings" frontmatter property. Populating the "misspellings" list in frontmatter is a great way to improve accuracy for linking to entities that are often misspelled with automatic transcription, such as people's names.

## License

This project is released under the MIT License. See [LICENSE](LICENSE) for details.
