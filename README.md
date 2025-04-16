# Obsidian Transcription

Transcription 3.0, with [Swiftink.io](https://www.swiftink.io/) domain-aware speech-to-text! Create high-quality text transcriptions from any media file, on any device. Best-in-class ASR via [OpenAI Whisper](https://openai.com/blog/whisper/).

## NOTE

If you are experiencing issues with logging in to Swiftink, please update the plugin to the latest version.

![Demo](media/demo.gif)

## Features

-   Wide range of audio and video file formats supported via [ffmpeg](https://ffmpeg.org/).
-   Flexible transcription engines - cloud or local
    -   [Swiftink.io](https://www.swiftink.io/) - free, high-quality, domain-aware speech-to-text
    -   [Whisper ASR](https://github.com/ahmetoner/whisper-asr-webservice) - local, open-source
-   Start and end timestamps for each line of the transcription
-   Transcribe multiple files at once
-   Transcribe files in the background
-   Summaries, outlines, and notes for each transcription with [Swiftink.io](https://www.swiftink.io/)

## How to use

### Installation and setup

[![Tutorial](https://img.youtube.com/vi/EyfhLGF3Fxg/0.jpg)](https://www.youtube.com/watch?v=EyfhLGF3Fxg)

## Contact

Contact me by [email](mailto:sulaiman@swiftink.io) at or on Twitter [@sulaimanghori](https://twitter.com/sulaimanghori) if you have any comments, issues, or suggestions!

## Credits

-   [Whisper ASR](https://github.com/ahmetoner/whisper-asr-webservice) by Ahmed, for the easy-to-use Whisper webservice backend

## Example template

```yaml
additional_inputs:
  - name: folder_files
    type: file_list
    path: /
    frontmatterProperties:
      - aliases 

  - name: readme_text
    type: file_content
    path: Other Guy.md

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
    if: "needs_clarification == 'Yes'"
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
