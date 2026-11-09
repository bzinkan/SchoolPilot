import ProductAboutIcon, { ProductAboutPlane } from './ProductAboutIcon';
import ProductAboutPreview from './ProductAboutPreview';
import './productAbout.css';

const products = [
  { id: 'classpilot', name: 'ClassPilot' },
  { id: 'passpilot', name: 'PassPilot' },
  { id: 'gopilot', name: 'GoPilot' },
];

const content = {
  passpilot: {
    name: 'PassPilot',
    category: 'Digital hall passes',
    headline: <>Every hall pass.<br />A clearer picture.</>,
    description: 'See who’s out, where they’re headed, and how long they’ve been gone. Bring your classroom’s hall pass routine into one shared view.',
    note: 'Teacher-issued passes. Student-friendly kiosks.',
    features: [
      { icon: 'clock', title: 'Know who’s out', text: 'Follow active passes with elapsed time and clear overdue flags.' },
      { icon: 'kiosk', title: 'Keep checkout simple', text: 'Issue passes as staff, or let students use a classroom kiosk.' },
      { icon: 'rules', title: 'Set school pass rules', text: 'Manage destination capacity and daily pass limits.' },
      { icon: 'report', title: 'See the bigger picture', text: 'Review student and class history, with reports and CSV exports.' },
    ],
    workflowIcon: 'kiosk',
    workflowHeading: <>From classroom <br />to check-in.</>,
    workflowIntro: <>A simple routine for students. <br />A shared record for staff.</>,
    steps: [
      { title: 'Start a pass', text: 'Staff choose a student and destination, or students check out at an authorized classroom kiosk.' },
      { title: 'Follow the trip', text: 'See the destination and elapsed time. Overdue flags help staff spot passes that need attention.' },
      { title: 'Close the loop', text: 'Students check back in, or staff mark them returned. Completed trips stay in pass history.' },
    ],
    detailIcon: 'clock',
    detailTitle: 'A planned trip? Put it on the calendar.',
    detailText: 'Schedule one-time student appointments so teachers can see upcoming visits and open a pass when it’s time.',
    closing: 'Make room for a better hall pass routine.',
  },
  gopilot: {
    name: 'GoPilot',
    category: 'School dismissal',
    headline: <>A shared plan<br />for the final bell.</>,
    description: 'Connect arrivals, classroom releases, and pickup in one staff-managed workflow. Give your dismissal team a clearer view of what happens next.',
    features: [
      { icon: 'car', title: 'Welcome arrivals', text: 'Office staff add arrivals by car number or student and family search.' },
      { icon: 'bell', title: 'Keep classrooms in sync', text: 'Teachers see calls and release their assigned students.' },
      { icon: 'shield', title: 'Manage pickup contacts', text: 'School staff approve and revoke authorized pickup contacts.' },
      { icon: 'rules', title: 'Handle today’s changes', text: 'Record same-day dismissal changes and choose pickup zones.' },
    ],
    workflowIcon: 'school',
    workflowHeading: <>One handoff <br />at a time.</>,
    workflowIntro: <>Clear responsibilities from arrival <br />to the final pickup.</>,
    steps: [
      { title: 'Office staff add and call arrivals', text: 'Use a car number or student search, then call students to the right pickup zone.' },
      { title: 'Teachers release from class', text: 'Each teacher sees and releases only the students assigned to them.' },
      { title: 'Office staff complete pickup', text: 'Follow students through the queue and record the final handoff. After-school plans remain visible in a separate list.' },
    ],
    detailIcon: 'shield',
    detailTitle: 'School staff stay in control.',
    detailText: 'Arrivals, classroom releases, and final pickup have distinct staff responsibilities, with a recorded dismissal history.',
    closing: 'Give your dismissal team a shared plan.',
  },
};

function Brand({ small = false }) {
  return (
    <a className={`pa-brand${small ? ' pa-small' : ''}`} href="/" aria-label="Schoolpilot home">
      <span className="pa-brandmark"><ProductAboutPlane /></span>
      <span>Schoolpilot</span>
    </a>
  );
}

export default function ProductAboutPage({ product }) {
  const page = content[product];

  return (
    <div className={`product-about product-about--${product}`}>
      <header className="pa-nav pa-wrap">
        <Brand />
        <nav aria-label="Products">
          {products.map(item => (
            <a key={item.id} href={`/products/${item.id}`} className={product === item.id ? 'pa-selected' : undefined} aria-current={product === item.id ? 'page' : undefined}>
              {item.name}
            </a>
          ))}
        </nav>
        <a className="pa-nav-cta" href="/get-started">Request information</a>
      </header>

      <main>
        <section className="pa-hero pa-wrap" aria-labelledby={`${product}-title`}>
          <div className="pa-hero-copy">
            <div className="pa-product-tag"><i aria-hidden="true" />{page.name}<span>{page.category}</span></div>
            <h1 id={`${product}-title`}>{page.headline}</h1>
            <p className="pa-lede">{page.description}</p>
            <div className="pa-hero-actions">
              <a className="pa-button" href="/get-started">Request information</a>
              <a className="pa-text-link" href="#how-it-works">See how it works <ProductAboutIcon name="arrow" /></a>
            </div>
            {page.note ? <p className="pa-hero-note">{page.note}</p> : (
              <div className="pa-dismissal-modes">
                <span><ProductAboutIcon name="car" />Car riders</span>
                <span><ProductAboutIcon name="bus" />Bus riders</span>
                <span><ProductAboutIcon name="walk" />Walkers</span>
              </div>
            )}
          </div>
          <ProductAboutPreview product={product} />
        </section>

        <section className="pa-features pa-wrap" aria-label={`${page.name} features`}>
          <h2 className="pa-sr-only">{page.name} features</h2>
          {page.features.map(feature => (
            <article key={feature.title}>
              <ProductAboutIcon name={feature.icon} />
              <h3>{feature.title}</h3>
              <p>{feature.text}</p>
            </article>
          ))}
        </section>

        <section id="how-it-works" className="pa-workflow pa-wrap" aria-labelledby={`${product}-workflow`}>
          <div className="pa-section-intro">
            <div className="pa-section-symbol"><ProductAboutIcon name={page.workflowIcon} /></div>
            <h2 id={`${product}-workflow`}>{page.workflowHeading}</h2>
            <p>{page.workflowIntro}</p>
          </div>
          <div className="pa-workflow-steps">
            {page.steps.map((step, index) => (
              <article key={step.title}>
                <span className="pa-step-count" aria-hidden="true">{index + 1}</span>
                <div><h3>{step.title}</h3><p>{step.text}</p></div>
              </article>
            ))}
          </div>
        </section>

        <section className="pa-appointment pa-wrap" aria-labelledby={`${product}-details`}>
          <div><ProductAboutIcon name={page.detailIcon} /><h2 id={`${product}-details`}>{page.detailTitle}</h2></div>
          <p>{page.detailText}</p>
        </section>

        <section className="pa-closing pa-wrap" aria-labelledby={`${product}-inquiry`}>
          <div className="pa-closing-icon"><ProductAboutIcon name={page.workflowIcon} /></div>
          <div>
            <h2 id={`${product}-inquiry`}>{page.closing}</h2>
            <p>Tell us about your school. We’ll help you explore {page.name} and plan your setup.</p>
          </div>
          <a className="pa-button pa-light" href="/get-started">Request information</a>
        </section>
      </main>

      <footer className="pa-wrap">
        <Brand small />
        <span>School tools that work together.</span>
        <nav className="pa-footer-products" aria-label="More products">
          {products.map(item => <a key={item.id} href={`/products/${item.id}`}>{item.name}</a>)}
        </nav>
        <div>
          <a href="/privacy">Privacy</a>
          <a href="/terms">Terms</a>
          <a href="mailto:hello@school-pilot.net">Contact</a>
        </div>
      </footer>
    </div>
  );
}
