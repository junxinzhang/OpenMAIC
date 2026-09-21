import { zaokitResponse, zaokitResponseText } from '@/lib/zaokit/api';
import type { PDFParserConfig } from './types';
import type { ParsedPdfContent } from '@/lib/types/pdf';

export async function parseWithZaokit(
  config: PDFParserConfig,
  buffer: Buffer,
  fileName = 'document.pdf',
): Promise<ParsedPdfContent> {
  const data = await zaokitResponse(config, {
    input: [
      {
        role: 'user',
        content: [
          {
            type: 'input_file',
            filename: fileName,
            file_data: `data:application/pdf;base64,${buffer.toString('base64')}`,
          },
          {
            type: 'input_text',
            text: 'Extract the full text of this PDF in reading order. Preserve headings, tables as Markdown, and formulas as LaTeX. Do not summarize or invent missing content. Return only the extracted document.',
          },
        ],
      },
    ],
  });
  return { text: zaokitResponseText(data), images: [] };
}
