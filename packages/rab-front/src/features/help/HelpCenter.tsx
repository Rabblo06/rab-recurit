import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { IconArrowUpRight, IconSearch } from '@tabler/icons-react';
import PageHeader from '../../shared/components/PageHeader';
import { HELP_TOPICS, searchTopics } from './help-topics';
import './help.css';

/** Help Center: how-to topics for workflows that exist in this app (help-topics.ts), searchable, each linking to its page. */
export default function HelpCenter() {
  const [query, setQuery] = useState('');
  const topics = useMemo(() => searchTopics(query), [query]);
  const sections = [...new Set(HELP_TOPICS.map((t) => t.section))];
  return (
    <div className="page help-page">
      <PageHeader title="Help Center" />
      <div className="page-scroll help-scroll">
        <div className="help-intro">
          <h2>How can we help?</h2>
          <p>Short guides to the things you do in Crewflow every day.</p>
          <label className="help-search">
            <IconSearch size={16} stroke={1.6} aria-hidden="true" />
            <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search help" aria-label="Search help" />
          </label>
        </div>
        {topics.length === 0 ? (
          <p className="help-empty" role="status">No help topics match “{query}”. Try another word, or see <Link to="/support">Support</Link>.</p>
        ) : sections.map((section) => {
          const inSection = topics.filter((t) => t.section === section);
          if (!inSection.length) return null;
          return (
            <section key={section} className="help-section" aria-labelledby={`help-${section}`}>
              <h3 id={`help-${section}`}>{section}</h3>
              <div className="help-grid">
                {inSection.map((t) => (
                  <article key={t.id} className="help-card" id={t.id}>
                    <h4>{t.title}</h4>
                    <p>{t.summary}</p>
                    <ol>{t.steps.map((s) => <li key={s}>{s}</li>)}</ol>
                    {t.link && <Link className="help-link" to={t.link.to}>{t.link.label} <IconArrowUpRight size={13} stroke={1.6} aria-hidden="true" /></Link>}
                  </article>
                ))}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}
