import ProductAboutIcon, { ProductAboutPlane } from './ProductAboutIcon';

const samplePasses = [
  { initials: 'JM', name: 'Jordan M.', destination: 'Restroom', elapsed: '2 min', color: 'blue', status: 'Active' },
  { initials: 'AL', name: 'Alex L.', destination: 'Main office', elapsed: '4 min', color: 'purple', status: 'Active' },
  { initials: 'SR', name: 'Sam R.', destination: 'Restroom', elapsed: '7 min', color: 'amber', status: 'Overdue' },
];

const sampleQueue = [
  { car: '124', name: 'Jordan M.', room: '204', status: 'Waiting', color: 'amber' },
  { car: '086', name: 'Maya L.', room: '204', status: 'Called', color: 'purple' },
  { car: '211', name: 'Alex R.', room: '108', status: 'In transit', color: 'blue' },
];

function PreviewHeader({ name, initials }) {
  return (
    <div className="pa-app-head">
      <span className="pa-mini-logo"><ProductAboutPlane /></span>
      <b>{name}</b>
      <span className="pa-app-school">Maple Grove School</span>
      <span className="pa-avatar">{initials}</span>
    </div>
  );
}

function PassPilotPreview() {
  return (
    <>
      <div className="pa-dashboard">
        <PreviewHeader name="PassPilot" initials="JT" />
        <div className="pa-app-body">
          <aside>
            <span className="pa-side-active"><ProductAboutIcon name="school" />My class</span>
            <span><ProductAboutIcon name="clock" />Active passes</span>
            <span><ProductAboutIcon name="report" />Reports</span>
            <span><ProductAboutIcon name="rules" />School setup</span>
            <div className="pa-side-bottom">School-managed<br />hall passes</div>
          </aside>
          <div className="pa-app-main">
            <div className="pa-title-row">
              <div><span className="pa-subtle">Ms. Taylor’s class</span><h3>Who’s out right now?</h3></div>
              <span className="pa-mock-button">+ Issue pass</span>
            </div>
            <div className="pa-app-tabs"><b>Active passes <span>3</span></b><span>Class roster</span><span>Pass data</span></div>
            {samplePasses.map(pass => (
              <div className="pa-pass-row" key={pass.initials}>
                <span className={`pa-initials pa-${pass.color}`}>{pass.initials}</span>
                <div><b>{pass.name}</b><span>{pass.destination}</span></div>
                <div className={`pa-elapsed${pass.status === 'Overdue' ? ' pa-overdue' : ''}`}><b>{pass.elapsed}</b><span>Elapsed time</span></div>
                <span className={`pa-status pa-${pass.status === 'Overdue' ? 'amber' : 'blue'}`}>{pass.status}</span>
              </div>
            ))}
            <div className="pa-destination">
              <span><ProductAboutIcon name="rules" />Restroom capacity</span><b>2 of 3</b>
              <div className="pa-capacity"><i /><i /><i className="pa-empty" /></div>
            </div>
          </div>
        </div>
      </div>
      <div className="pa-kiosk-card">
        <div className="pa-kiosk-top"><ProductAboutIcon name="kiosk" />Classroom kiosk<span className="pa-online">Ready</span></div>
        <h4>Where are you going?</h4>
        <div className="pa-kiosk-options"><span>Restroom</span><span>Office</span><span>Nurse</span></div>
        <div className="pa-kiosk-footer">Choose a destination to check out</div>
      </div>
    </>
  );
}

function GoPilotPreview() {
  return (
    <>
      <div className="pa-dashboard">
        <PreviewHeader name="GoPilot" initials="OP" />
        <div className="pa-go-main">
          <div className="pa-title-row">
            <div><span className="pa-subtle">Office view</span><h3>Afternoon dismissal</h3></div>
            <span className="pa-session-status"><i />Session active</span>
          </div>
          <div className="pa-queue-metrics">
            <div><b>3</b><span>Waiting</span></div><div><b>2</b><span>Called</span></div>
            <div><b>1</b><span>In transit</span></div><div><b>18</b><span>Dismissed</span></div>
          </div>
          <div className="pa-mock-search"><ProductAboutIcon name="search" />Search student or car number</div>
          <div className="pa-queue-heading"><b>Pickup queue</b><span>Front entrance</span></div>
          {sampleQueue.map(student => (
            <div className="pa-queue-row" key={student.car}>
              <span className="pa-car-no">{student.car}</span>
              <div><b>{student.name}</b><span>Room {student.room} · Car rider</span></div>
              <span className={`pa-status pa-${student.color}`}>{student.status}</span>
            </div>
          ))}
          <div className="pa-queue-foot"><ProductAboutIcon name="shield" />Office staff complete final pickup</div>
        </div>
      </div>
      <div className="pa-teacher-card">
        <div className="pa-kiosk-top"><ProductAboutIcon name="bell" />Room 204<span className="pa-teacher-label">Teacher view</span></div>
        <div className="pa-teacher-student"><span className="pa-initials pa-purple">ML</span><div><b>Maya L.</b><span>Called to Front entrance</span></div></div>
        <span className="pa-release">Release from class <ProductAboutIcon name="check" /></span>
        <div className="pa-kiosk-footer">Teachers see only their assigned students</div>
      </div>
    </>
  );
}

export default function ProductAboutPreview({ product }) {
  const description = product === 'passpilot'
    ? 'Sample PassPilot dashboard showing active passes, elapsed minutes, an overdue flag and restroom capacity, alongside a classroom kiosk.'
    : 'Sample GoPilot office queue showing waiting, called, in-transit and dismissed states, alongside a teacher’s assigned-student release view.';

  return (
    <figure className="pa-product-stage">
      <div className="pa-route-decoration" aria-hidden="true" />
      <div className="pa-preview-image" role="img" aria-label={`${description} All students and activity are illustrative sample data.`}>
        <div aria-hidden="true" className="pa-preview-content">
          {product === 'passpilot' ? <PassPilotPreview /> : <GoPilotPreview />}
        </div>
      </div>
      <figcaption className="pa-sample-caption">Illustrative interfaces with sample data</figcaption>
    </figure>
  );
}
