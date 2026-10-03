// Pure CI entry point: no Docker, database, image build or offered workload.
import './prototype.test.mjs';
import './adapters.test.mjs';
import './orchestrator.test.mjs';
import './runtime-contract.test.mjs';
import './image-probe.test.mjs';
import './snapshot-contract.test.mjs';
import './numerical-checks.test.mjs';
import './snapshot-validity-horizon.test.mjs';
import './restore-snapshot.test.mjs';
import './receipt-writer.test.mjs';
import './restored-role-scale.test.mjs';
import './campaign-validation.test.mjs';
import './campaign-journal.test.mjs';
