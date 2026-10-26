import { render, screen } from '@testing-library/react';

import SafeMarkdown, { safeExternalUrl } from './SafeMarkdown';

describe('SafeMarkdown — unsafe content is inert', () => {
  it('raw HTML (script, iframe, img onerror, inline handlers) is shown as literal text and never becomes an element', () => {
    const hostile = [
      '<script>window.__pwned = 1</script>',
      '<img src="https://evil.test/x.png" onerror="window.__pwned = 2">',
      '<iframe src="https://evil.test"></iframe>',
      '<a href="javascript:alert(1)">click</a>',
      '<b onclick="alert(1)">bold?</b>',
    ].join('\n\n');
    const { container } = render(<SafeMarkdown text={hostile} />);
    expect(container.querySelector('script, img, iframe, b, [onerror], [onclick]')).toBeNull();
    // A bare http(s) URL inside the text may become an ordinary safe link; nothing else can.
    for (const a of Array.from(container.querySelectorAll('a'))) expect(a.getAttribute('href')).toMatch(/^https:\/\/evil\.test\//);
    expect(container.querySelector('a[href^="javascript"]')).toBeNull();
    expect(container.textContent).toContain('<script>window.__pwned = 1</script>');
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
  });

  it('javascript:, data:, vbscript:, relative, protocol-relative and credentialed links render as plain text', () => {
    const text = [
      '[a](javascript:alert(1))',
      '[b](JaVaScRiPt:alert(1))',
      '[c](data:text/html;base64,PHNjcmlwdD4=)',
      '[d](vbscript:msgbox)',
      '[e](/settings/admin)',
      '[f](//evil.test/x)',
      '[g](https://user:pass@evil.test/)',
      '<javascript:alert(1)>',
    ].join('\n\n');
    const { container } = render(<SafeMarkdown text={text} />);
    expect(container.querySelectorAll('a')).toHaveLength(0);
    const paragraphs = Array.from(container.querySelectorAll('p')).map((p) => p.textContent?.[0]);
    expect(paragraphs.slice(0, 7)).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g']);
  });

  it('images are never loaded: ![alt](url) becomes a plain link (safe URL) or text (unsafe URL)', () => {
    const { container } = render(<SafeMarkdown text={'![chart](https://cdn.example.test/chart.png)\n\n![tracker](javascript:alert(1))'} />);
    expect(container.querySelector('img')).toBeNull();
    const link = screen.getByRole('link', { name: 'Image: chart' });
    expect(link).toHaveAttribute('href', 'https://cdn.example.test/chart.png');
    expect(screen.getByText(/Image: tracker/).closest('a')).toBeNull();
  });

  it('safe http(s) links open in a new tab with rel="noopener noreferrer" (markdown, <autolink> and bare URL)', () => {
    render(<SafeMarkdown text={'See [the rota](https://example.test/rota?x=1) or <https://example.test/a> or https://example.test/b.'} />);
    const links = screen.getAllByRole('link');
    expect(links.map((a) => a.getAttribute('href'))).toEqual(['https://example.test/rota?x=1', 'https://example.test/a', 'https://example.test/b']);
    for (const a of links) {
      expect(a).toHaveAttribute('target', '_blank');
      expect(a).toHaveAttribute('rel', 'noopener noreferrer');
    }
  });
});

describe('SafeMarkdown — the supported subset', () => {
  it('renders paragraphs, bold/italic/code, lists, quotes, code blocks and headings as plain elements', () => {
    const { container } = render(
      <SafeMarkdown
        text={['## Weekend', '3 shift(s) still need **staff** (*Sat*):', '- Bartender at The Mill: `2` of 3', '- Chef', '', '1. first', '2. second', '', '> quoted', '', '```', '<b>not html</b>', '```'].join('\n')}
      />,
    );
    expect(container.querySelector('h1, h2, h3')).toBeNull(); // headings never become page headings
    expect(screen.getByText('Weekend').tagName).toBe('STRONG');
    expect(screen.getByText('staff').tagName).toBe('STRONG');
    expect(screen.getByText('Sat').tagName).toBe('EM');
    expect(screen.getByText('2').tagName).toBe('CODE');
    expect(container.querySelectorAll('ul > li')).toHaveLength(2);
    expect(container.querySelectorAll('ol > li')).toHaveLength(2);
    expect(container.querySelector('blockquote')).toHaveTextContent('quoted');
    expect(container.querySelector('pre code')).toHaveTextContent('<b>not html</b>');
    expect(container.querySelector('pre b')).toBeNull();
  });

  it('safeExternalUrl accepts only absolute http(s) without credentials', () => {
    expect(safeExternalUrl('https://example.test/a b')).toBeNull();
    expect(safeExternalUrl('http://example.test')).toBe('http://example.test/');
    expect(safeExternalUrl('ftp://example.test')).toBeNull();
    expect(safeExternalUrl('https://example.test\\@evil.test')).toBeNull();
  });
});

describe('SafeMarkdown — U2 tables and record references', () => {
  const ID = '5a0e0c4e-3333-4222-8333-444455556666';

  it('without a record renderer (streaming) a reference stays plain text', () => {
    const { container } = render(<SafeMarkdown text={`Gap: [[record:shift:${ID}]]`} />);
    expect(container.textContent).toBe(`Gap: [[record:shift:${ID}]]`);
  });

  it('with a renderer (stored content) only well-formed references of the three types reach it (lower-case ids only, the @rab/shared pattern)', () => {
    const seen: string[] = [];
    render(
      <SafeMarkdown
        text={`A [[record:shift:${ID.toUpperCase()}]] B [[record:payroll:${ID}]] C [[record:venue:not-a-uuid]] **[[record:venue:${ID}]]**`}
        renderRecord={(ref, key) => {
          seen.push(`${ref.type}:${ref.id}`);
          return <span key={key} data-testid="chip">{ref.type}</span>;
        }}
      />,
    );
    // Batch 3 S2 contract: the server stores only lower-case ids, so an upper-case one is not a reference and stays text.
    expect(seen).toEqual([`venue:${ID}`]);
    expect(screen.getAllByTestId('chip')).toHaveLength(1);
    expect(screen.getByText(/\[\[record:payroll:/)).toBeInTheDocument();
    expect(screen.getByText(new RegExp(`record:shift:${ID.toUpperCase()}`))).toBeInTheDocument();
  });

  it('tables: header cells are column headers, escaped pipes stay in the cell, oversized tables are shortened with a note', () => {
    const rows = Array.from({ length: 205 }, (_, i) => `| r${i} | a \\| b |`).join('\n');
    const { container } = render(<SafeMarkdown text={`| Name | Value |\n|:---|---:|\n${rows}`} />);
    expect(screen.getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['Name', 'Value']);
    expect(container.querySelectorAll('tbody tr')).toHaveLength(200);
    expect(screen.getAllByText('a | b').length).toBe(200);
    expect(screen.getByText('Table shortened to 200 rows and 20 columns.')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Table' })).toHaveAttribute('tabindex', '0');
  });
});
