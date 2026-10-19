import type { ReactNode } from 'react';

type MarkdownTextProps = {
  content: string;
  onImageClick?: (src: string, alt?: string) => void;
};

type ParsedImage = {
  alt: string;
  caption: string;
  src: string;
};

const blockStarter = /^(\s*[-*]\s+|\s*\d+\.\s+|#{1,4}\s+|>\s*|```|\s*-{3,}\s*$|\s*\||\s*!\[|\s*<img\b)/i;

const inlinePattern =
  /!\[([^\]]*)\]\s*\((https?:\/\/[^)\s]+?)(?:\s+["']([^"']*)["'])?\s*\)|<img\b[^>]*>|`[^`]+`|\*\*[^*\n]+\*\*|(?<!\*)\*[^*\n]+\*(?!\*)|(?<!_)_[^_\n]+_(?!_)|\[[^\]]+\]\((?:https?:\/\/[^)\s]+)\)/gi;

const markdownImagePattern = /!\[([^\]]*)\]\s*\((https?:\/\/[^)\s]+?)(?:\s+["']([^"']*)["'])?\s*\)/i;
const htmlImagePattern = /^<img\b[^>]*>$/i;

const sanitizeImageUrl = (value: string) => {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
};

const getHtmlAttribute = (tag: string, attribute: string) => {
  const match = tag.match(new RegExp(`${attribute}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i'));
  return (match?.[2] ?? match?.[3] ?? '').trim();
};

const parseMarkdownImage = (token: string): ParsedImage | null => {
  const match = token.match(markdownImagePattern);
  if (!match) {
    return null;
  }

  const src = sanitizeImageUrl(match[2]);
  if (!src) {
    return null;
  }

  return {
    src,
    alt: (match[1] || '').trim(),
    caption: (match[3] || '').trim(),
  };
};

const parseHtmlImage = (token: string): ParsedImage | null => {
  if (!htmlImagePattern.test(token)) {
    return null;
  }

  const src = sanitizeImageUrl(getHtmlAttribute(token, 'src'));
  if (!src) {
    return null;
  }

  return {
    src,
    alt: getHtmlAttribute(token, 'alt'),
    caption: getHtmlAttribute(token, 'title') || getHtmlAttribute(token, 'data-caption'),
  };
};

const parseImageToken = (token: string) => parseMarkdownImage(token) ?? parseHtmlImage(token);

const parseEmphasisToken = (token: string) => {
  if (
    token.length >= 3 &&
    ((token.startsWith('*') && token.endsWith('*')) ||
      (token.startsWith('_') && token.endsWith('_')))
  ) {
    return token.slice(1, -1).trim();
  }

  return null;
};

const renderImage = (
  image: ParsedImage,
  key: string,
  mode: 'block' | 'inline' = 'block',
  onImageClick?: (src: string, alt?: string) => void,
) => {
  const alt = image.alt || image.caption || 'Referenced image';

  const handleClick = (e: any) => {
    if (onImageClick) {
      e.preventDefault();
      onImageClick(image.src, alt);
    }
  };

  if (mode === 'inline') {
    return (
      <a
        className="md-inline-image-link"
        href={image.src}
        key={key}
        rel="noreferrer"
        target="_blank"
        onClick={handleClick}
      >
        <img alt={alt} className="md-inline-image" loading="lazy" src={image.src} />
      </a>
    );
  }

  return (
    <figure className="md-figure" key={key}>
      <a
        className="md-image-link"
        href={image.src}
        rel="noreferrer"
        target="_blank"
        onClick={handleClick}
      >
        <img alt={alt} className="md-image" loading="lazy" src={image.src} />
      </a>
      {image.caption ? <figcaption>{image.caption}</figcaption> : null}
    </figure>
  );
};

const renderInline = (
  text: string,
  keyPrefix: string,
  onImageClick?: (src: string, alt?: string) => void,
): ReactNode[] => {
  const nodes: ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  // Clone the global regex so recursive calls don't corrupt lastIndex
  const localPattern = new RegExp(inlinePattern.source, inlinePattern.flags);

  while ((match = localPattern.exec(text)) !== null) {
    // Guard against zero-length matches that would stall the loop forever
    if (match[0].length === 0) {
      localPattern.lastIndex = match.index + 1;
      continue;
    }

    if (match.index > lastIndex) {
      nodes.push(text.slice(lastIndex, match.index));
    }

    const token = match[0];
    const image = parseImageToken(token);
    const link = token.match(/^\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)$/i);
    const emphasis = parseEmphasisToken(token);

    if (image) {
      nodes.push(
        renderImage(image, `${keyPrefix}-image-${match.index}`, 'inline', onImageClick),
      );
    } else if (token.startsWith('**') && token.endsWith('**')) {
      nodes.push(
        <strong key={`${keyPrefix}-bold-${match.index}`}>{token.slice(2, -2)}</strong>,
      );
    } else if (emphasis) {
      nodes.push(<em key={`${keyPrefix}-italic-${match.index}`}>{emphasis}</em>);
    } else if (token.startsWith('`') && token.endsWith('`')) {
      nodes.push(<code key={`${keyPrefix}-code-${match.index}`}>{token.slice(1, -1)}</code>);
    } else if (link && /^\d{1,2}$/.test(link[1])) {
      // [n](url) comes from inline source citations
      nodes.push(
        <sup className="citation" key={`${keyPrefix}-cite-${match.index}`}>
          <a aria-label={`Source ${link[1]}`} href={link[2]} rel="noreferrer" target="_blank" title={link[2]}>
            {link[1]}
          </a>
        </sup>,
      );
    } else if (link) {
      nodes.push(
        <a
          href={link[2]}
          key={`${keyPrefix}-link-${match.index}`}
          rel="noreferrer"
          target="_blank"
        >
          {renderInline(link[1], `${keyPrefix}-link-text-${match.index}`, onImageClick)}
        </a>,
      );
    }

    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex));
  }

  return nodes;
};

const collectParagraph = (lines: string[], startIndex: number) => {
  const paragraph: string[] = [];
  let index = startIndex;

  while (index < lines.length && lines[index].trim() && !blockStarter.test(lines[index])) {
    paragraph.push(lines[index].trim());
    index += 1;
  }

  return { index, text: paragraph.join(' ') };
};

const isPlainHeading = (line: string, nextLine?: string) => {
  const words = line.trim().split(/\s+/);
  return Boolean(
    nextLine !== undefined &&
      !nextLine.trim() &&
      words.length <= 5 &&
      /^[A-Z][A-Za-z0-9 &/+-]+$/.test(line.trim()) &&
      !/[.?!:]$/.test(line.trim()),
  );
};

const parseTableRow = (line: string) =>
  line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());

const isTableSeparator = (line: string) => /^\s*\|?[\s:-]+(?:\|[\s:-]+)+\|?\s*$/.test(line);

const MarkdownText = ({ content, onImageClick }: MarkdownTextProps) => {
  const lines = content
    .replace(/\r\n/g, '\n')
    .replace(/\|\s+(?=\|)/g, '|\n')
    .split('\n');
  const blocks: ReactNode[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    const trimmed = line.trim();

    if (!trimmed) {
      index += 1;
      continue;
    }

    if (/^-{3,}$/.test(trimmed)) {
      blocks.push(<hr key={`hr-${index}`} />);
      index += 1;
      continue;
    }

    const standaloneImage = parseImageToken(trimmed);
    if (standaloneImage) {
      blocks.push(
        renderImage(standaloneImage, `image-${index}`, 'block', onImageClick) as ReactNode,
      );
      index += 1;
      continue;
    }

    if (trimmed.startsWith('```')) {
      const language = trimmed.replace(/^```/, '').trim();
      const codeLines: string[] = [];
      index += 1;

      while (index < lines.length && !lines[index].trim().startsWith('```')) {
        codeLines.push(lines[index]);
        index += 1;
      }

      index += 1;
      blocks.push(
        <pre className="md-codeblock" key={`code-${index}`}>
          {language ? <span>{language}</span> : null}
          <code>{codeLines.join('\n')}</code>
        </pre>,
      );
      continue;
    }

    if (trimmed.startsWith('|') && lines[index + 1] && isTableSeparator(lines[index + 1])) {
      const header = parseTableRow(trimmed);
      const rows: string[][] = [];
      index += 2;

      while (index < lines.length && lines[index].trim().startsWith('|')) {
        if (!isTableSeparator(lines[index])) {
          rows.push(parseTableRow(lines[index]));
        }
        index += 1;
      }

      blocks.push(
        <div className="md-table-wrap" key={`table-${index}`}>
          <table>
            <thead>
              <tr>
                {header.map((cell, cellIndex) => (
                  <th key={`${cell}-${cellIndex}`}>{renderInline(cell, `th-${index}-${cellIndex}`)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, rowIndex) => (
                <tr key={`row-${index}-${rowIndex}`}>
                  {header.map((_cell, cellIndex) => (
                    <td key={`cell-${index}-${rowIndex}-${cellIndex}`}>
                      {renderInline(row[cellIndex] ?? '', `td-${index}-${rowIndex}-${cellIndex}`)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }

    const heading = trimmed.match(/^(#{1,4})\s+(.+)$/);
    if (heading) {
      const level = Math.min(heading[1].length, 4);
      const headingTags = ['h2', 'h3', 'h4', 'h5'] as const;
      const Tag = headingTags[level - 1];
      blocks.push(<Tag key={`heading-${index}`}>{renderInline(heading[2], `heading-${index}`)}</Tag>);
      index += 1;
      continue;
    }

    if (isPlainHeading(trimmed, lines[index + 1])) {
      blocks.push(<h3 key={`plain-heading-${index}`}>{renderInline(trimmed, `plain-heading-${index}`)}</h3>);
      index += 1;
      continue;
    }

    if (trimmed.startsWith('>')) {
      const quoteLines: string[] = [];

      while (index < lines.length && lines[index].trim().startsWith('>')) {
        quoteLines.push(lines[index].replace(/^\s*>\s?/, '').trim());
        index += 1;
      }

      blocks.push(
        <blockquote key={`quote-${index}`}>
          {renderInline(quoteLines.join(' '), `quote-${index}`, onImageClick)}
        </blockquote>,
      );
      continue;
    }

    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = [];

      while (index < lines.length && /^\s*[-*]\s+/.test(lines[index])) {
        items.push(lines[index].replace(/^\s*[-*]\s+/, '').trim());
        index += 1;
      }

      blocks.push(
        <ul key={`ul-${index}`}>
          {items.map((item, itemIndex) => (
            <li key={`${item}-${itemIndex}`}>
              {renderInline(item, `ul-${index}-${itemIndex}`, onImageClick)}
            </li>
          ))}
        </ul>,
      );
      continue;
    }

    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = [];

      while (index < lines.length && /^\s*\d+\.\s+/.test(lines[index])) {
        items.push(lines[index].replace(/^\s*\d+\.\s+/, '').trim());
        index += 1;
      }

      blocks.push(
        <ol key={`ol-${index}`}>
          {items.map((item, itemIndex) => (
            <li key={`${item}-${itemIndex}`}>
              {renderInline(item, `ol-${index}-${itemIndex}`, onImageClick)}
            </li>
          ))}
        </ol>,
      );
      continue;
    }

    const paragraph = collectParagraph(lines, index);
    if (paragraph.index === index) {
      // Line matched blockStarter but no block handler claimed it — treat as plain text
      blocks.push(
        <p key={`p-${index}`}>{renderInline(trimmed, `p-${index}`, onImageClick)}</p>,
      );
      index += 1;
    } else {
      blocks.push(
        <p key={`p-${index}`}>{renderInline(paragraph.text, `p-${index}`, onImageClick)}</p>,
      );
      index = paragraph.index;
    }
  }

  return <div className="markdown-text">{blocks}</div>;
};

export default MarkdownText;
