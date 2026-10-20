"""Embeds (or refreshes) a narrated tutorial in an MDX page: VideoTutorial with poster + captions, plus a transcript.

    python tools/narration/embed.py <page.mdx> <slug> "<title>" [--replace <old video src>] [--after "<exact line>"] [--indent N]

The transcript is generated from tools/narration/scripts/<slug>.json (the exact narration), so page text and audio agree.
"""
import json, os, re, sys

root = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
args = sys.argv[1:]
page, slug, title = args[0], args[1], args[2]
opt = lambda k: args[args.index(k) + 1] if k in args else None
replace, after, indent = opt('--replace'), opt('--after'), int(opt('--indent') or 0)

build = json.load(open(os.path.join(root, 'tools', 'narration', 'build', slug, 'build.json'), encoding='utf8'))
script = json.load(open(os.path.join(root, 'tools', 'narration', 'scripts', slug + '.json'), encoding='utf8'))
secs = build['seconds']
duration = 'Under 1 minute' if secs < 60 else 'About 1 minute' if secs < 90 else 'About 1½ minutes' if secs < 110 else 'About 2½ minutes' if secs < 160 else f'About {round(secs / 60)} minutes'
pad = ' ' * indent
video = '/' + build['video']
esc = lambda t: t.replace('{', '&#123;').replace('}', '&#125;').replace('<', '&lt;').replace('>', '&gt;')
block = (f'{pad}<VideoTutorial src="{video}" poster="/videos/posters/{slug}.webp" captions="/videos/captions/{slug}.en.vtt" title="{title}" duration="{duration}" narrated />\n\n'
         f'{pad}<Accordion title="Video transcript" icon="closed-captioning">\n'
         + '\n\n'.join(f'{pad}  {esc(s["text"])}' for s in script['segments']) +
         f'\n{pad}</Accordion>\n')

path = os.path.join(root, page)
s = open(path, encoding='utf8').read()
# Drop a transcript that a previous run inserted for this same video, so re-running is idempotent.
s = re.sub(r'\n[ \t]*<Accordion title="Video transcript" icon="closed-captioning">\n.*?</Accordion>\n', '\n', s, flags=re.S) if f'/{build["video"]}' in s or (replace and replace in s) else s
if replace:
    m = re.search(r'[ \t]*<VideoTutorial[^>]*src="' + re.escape(replace) + r'"[^>]*/>\n', s, flags=re.S)
    if not m:
        sys.exit(f'{page}: no VideoTutorial with src {replace}')
    s = s[:m.start()] + block + s[m.end():]
elif after:
    if s.count(after + '\n') != 1:
        sys.exit(f'{page}: anchor line not found exactly once')
    s = s.replace(after + '\n', after + '\n\n' + block, 1)
else:
    sys.exit('need --replace or --after')
if not re.search(r"import \{[^}]*VideoTutorial[^}]*\} from '/snippets/media.mdx';", s):
    end = s.index('---', 3) + 3
    s = s[:end] + "\n\nimport { VideoTutorial } from '/snippets/media.mdx';" + s[end:]
open(path, 'w', encoding='utf8', newline='\n').write(s)
print(f'{page}: embedded {slug} ({duration})')
