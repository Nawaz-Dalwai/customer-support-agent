# Knowledge base data (WixQA subset)

The support articles in `kb/` and test questions in `eval/` come from
**WixQA** by Wix.com AI Research, released under the MIT License:
https://huggingface.co/datasets/Wix/WixQA

> Cohen et al., 2025. *WixQA: A Multi-Dataset Benchmark for Enterprise
> Retrieval-Augmented Generation.* arXiv:2505.08643

This is a local prototype for learning purposes. It is not affiliated with or
endorsed by Wix, and must not be presented as official Wix support.

## Contents

| Path | What it is |
|---|---|
| `kb/*.txt` | One help article per file (title, source URL, text). Uploaded to S3 for the Bedrock Knowledge Base. |
| `kb-manifest.json` | Article id → file name, source URL, and why it was included. |
| `eval/expertwritten.jsonl` | 200 real customer questions with expert answers and ground-truth articles. |
| `eval/simulated.jsonl` | 200 simulated customer questions with answers and ground-truth articles. |

## How the subset was chosen

- Every article referenced by the 400 test questions, so each question is answerable.
- Plus 160 random help articles as distractors (seeded, reproducible), so retrieval
  must pick the right article among unrelated ones.

Rebuild with:

```bash
node scripts/build-wixqa-subset.mjs <dir-with-wixqa-jsonl-files> 160
```

## MIT License notice (WixQA)

The dataset card states "Released under the MIT License. Cite 'Wix.com AI
Research' when using the data." The repository has no separate LICENSE file;
the standard MIT text follows.

Copyright (c) 2025 Wix.com AI Research

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
