/* eslint-disable @typescript-eslint/no-require-imports -- loaded inside a render thread, after its guard */
/**
 * TEST-ONLY document registry for the native render pool specs (render-pool.spec.ts) and the runtime benchmark. Loaded
 * INSIDE a render thread through the pool's `documentsModule` option, exactly like the production registry
 * (`native/native-documents`): it exports `NATIVE_DOCUMENT_REGISTRY`, one function per kind returning a `<Document>`.
 *
 * `test-table` mirrors the final timesheet's shape (header row repeated with `fixed`, zebra rows that never split,
 * 40-row page segments per D4, "Page x of y" footer) so timings are representative until the real layouts are wired.
 * The other kinds are deliberately hostile: a layout that never returns, one that exhausts the heap, one that tries the
 * network, one that reads the clock.
 */
import type { NativeDocumentMeta } from '../../queues/rab-reports/native/runtime/render-protocol';

const R =
  require('@react-pdf/renderer') as typeof import('@react-pdf/renderer');
const { createElement: h } = require('react') as typeof import('react');
const { FONT_FAMILY_STACK } =
  require('../../queues/rab-reports/native/runtime/native-fonts') as typeof import('../../queues/rab-reports/native/runtime/native-fonts');

const fontFamily = [...FONT_FAMILY_STACK];
const text = { fontFamily, fontSize: 8.25, color: '#1F2321' };

interface TextVm {
  title: string;
  lines: string[];
  bold?: boolean;
}
interface TableVm {
  title: string;
  columns: string[];
  rows: string[][];
  footerLeft: string;
}
interface ImageVm {
  title: string;
  png: Buffer;
}

function textDocument(vm: TextVm, meta: NativeDocumentMeta) {
  return h(
    R.Document,
    { ...meta, title: 'test' },
    h(
      R.Page,
      { size: 'A4', style: { padding: 34 } },
      h(
        R.Text,
        { style: { ...text, fontSize: 14, fontWeight: 700 } },
        vm.title,
      ),
      ...vm.lines.map((line, i) =>
        h(
          R.Text,
          { key: i, style: { ...text, fontWeight: vm.bold ? 700 : 400 } },
          line,
        ),
      ),
    ),
  );
}

const SEGMENT = 40;

function tableDocument(vm: TableVm, meta: NativeDocumentMeta) {
  const width = `${100 / vm.columns.length}%`;
  const header = h(
    R.View,
    {
      fixed: true,
      style: { flexDirection: 'row', backgroundColor: '#2A2B29' },
    },
    ...vm.columns.map((c, i) =>
      h(
        R.Text,
        {
          key: i,
          style: {
            ...text,
            width,
            color: '#FFFFFF',
            fontWeight: 700,
            padding: 5,
          },
        },
        c,
      ),
    ),
  );
  const segments: string[][][] = [];
  for (let i = 0; i < Math.max(vm.rows.length, 1); i += SEGMENT)
    segments.push(vm.rows.slice(i, i + SEGMENT));
  return h(
    R.Document,
    { ...meta },
    ...segments.map((rows, s) =>
      h(
        R.Page,
        {
          key: s,
          size: 'A4',
          orientation: 'landscape',
          style: { paddingTop: 34, paddingBottom: 45, paddingHorizontal: 34 },
        },
        s === 0
          ? h(
              R.Text,
              {
                style: {
                  ...text,
                  fontSize: 16,
                  fontWeight: 700,
                  marginBottom: 8,
                },
              },
              vm.title,
            )
          : null,
        h(
          R.View,
          null,
          header,
          ...rows.map((row, r) =>
            h(
              R.View,
              {
                key: r,
                wrap: false,
                style: {
                  flexDirection: 'row',
                  backgroundColor: r % 2 ? '#F4F5F3' : '#FFFFFF',
                  borderBottom: '0.75pt solid #ECEDEB',
                },
              },
              ...row.map((cell, c) =>
                h(
                  R.Text,
                  { key: c, style: { ...text, width, padding: 5 } },
                  cell,
                ),
              ),
            ),
          ),
        ),
        h(R.Text, {
          fixed: true,
          style: {
            ...text,
            position: 'absolute',
            bottom: 18,
            left: 34,
            right: 34,
            fontSize: 7,
            color: '#8A8F8C',
          },
          render: ({
            pageNumber,
            totalPages,
          }: {
            pageNumber: number;
            totalPages: number;
          }) => `${vm.footerLeft} · Page ${pageNumber} of ${totalPages}`,
        }),
      ),
    ),
  );
}

function imageDocument(vm: ImageVm, meta: NativeDocumentMeta) {
  if (!Buffer.isBuffer(vm.png))
    throw new Error('image bytes did not arrive as a Buffer');
  return h(
    R.Document,
    { ...meta },
    h(
      R.Page,
      { size: 'A4' },
      h(R.Text, { style: text }, vm.title),
      h(R.Image, {
        src: { data: vm.png, format: 'png' },
        style: { width: 96, height: 96 },
      }),
    ),
  );
}

export const NATIVE_DOCUMENT_REGISTRY = Object.freeze({
  'test-text': (vm: unknown, meta: NativeDocumentMeta) =>
    textDocument(vm as TextVm, meta),
  'test-table': (vm: unknown, meta: NativeDocumentMeta) =>
    tableDocument(vm as TableVm, meta),
  'test-image': (vm: unknown, meta: NativeDocumentMeta) =>
    imageDocument(vm as ImageVm, meta),
  /** Never returns: the pool must terminate the thread at the deadline. */
  'test-forever': () => {
    for (;;) {
      /* spin */
    }
  },
  /** Allocates until the thread's heap cap kills it. */
  'test-heap-bomb': () => {
    const hoard: number[][] = [];
    for (;;) hoard.push(new Array(1_000_000).fill(hoard.length));
  },
  /** Tries every way out to the network; the guard must refuse each, and the render still completes. */
  'test-network': (vm: unknown, meta: NativeDocumentMeta) => {
    const { url } = vm as { url: string };
    const attempts: string[] = [];
    for (const mod of [
      'http',
      'node:https',
      'net',
      'node:tls',
      'dns',
      'child_process',
      'worker_threads',
    ]) {
      try {
        require(mod);
        attempts.push(`${mod}:loaded`);
      } catch {
        attempts.push(`${mod}:refused`);
      }
    }
    void (globalThis.fetch as (u: string) => Promise<unknown>)(url).catch(
      () => undefined,
    );
    return h(
      R.Document,
      { ...meta },
      h(
        R.Page,
        { size: 'A4' },
        h(R.Text, { style: text }, attempts.join(' ')),
        // react-pdf would fetch() a string src; the guard's fetch stub refuses it.
        h(R.Image, {
          src: `${url}/logo.png`,
          style: { width: 10, height: 10 },
        }),
      ),
    );
  },
  /** Prints the thread's clock: D7 makes it the request's generatedAt, not the wall clock. */
  'test-clock': (_vm: unknown, meta: NativeDocumentMeta) =>
    h(
      R.Document,
      { ...meta },
      h(
        R.Page,
        { size: 'A4' },
        h(
          R.Text,
          { style: text },
          `now=${new Date().toISOString()} ms=${Date.now()}`,
        ),
      ),
    ),
});
