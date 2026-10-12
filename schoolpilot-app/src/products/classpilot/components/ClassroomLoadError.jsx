import { Button } from '../../../components/ui/button';
import { classroomLoadFailure } from '../lib/classroomActions';

export default function ClassroomLoadError({ error, subject, onConnect, onRetry, retrying }) {
  const failure = classroomLoadFailure(error, subject);
  return <div role="alert" className="space-y-2">
    <p>{failure.message}</p>
    <div className="flex flex-wrap gap-2">
      {failure.reconnect && <Button variant="outline" onClick={onConnect}>Reconnect Google</Button>}
      <Button variant="ghost" disabled={retrying} onClick={onRetry}>Retry {subject.toLowerCase()}</Button>
    </div>
  </div>;
}
