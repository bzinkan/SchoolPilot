import { createPortal } from 'react-dom';
import { ROOM_WIDTH, ROOM_HEIGHT, DESK_WIDTH, DESK_HEIGHT } from '../lib/seatingModel';

function nameLayout(name, context) {
  for (let fontSize = 16; fontSize >= 1; fontSize--) {
    if (context) context.font = `${fontSize}px Arial`;
    const width = text => context ? context.measureText(text).width : text.length * fontSize * .6;
    const words = [];
    for (const word of name.split(/\s+/)) {
      let chunk = '';
      for (const character of word) { if (chunk && width(chunk + character) > DESK_WIDTH - 12) { words.push(chunk); chunk = ''; } chunk += character; }
      if (chunk) words.push(chunk);
    }
    const lines = [''];
    for (const word of words) { const at = lines.length - 1; if (lines[at] && width(`${lines[at]} ${word}`) > DESK_WIDTH - 12) lines.push(word); else lines[at] = `${lines[at]} ${word}`.trim(); }
    if (lines.length * (fontSize + 1) <= 36 || fontSize === 1) return { lines, fontSize };
  }
}

export default function SeatingPrint({ chart, paper }) {
  const names = new Map(chart.roster.map(student => [student.id, student.name]));
  const context = document.createElement('canvas').getContext('2d');
  const seats = chart.layout.seats;
  const left = seats.length ? Math.min(...seats.map(seat => seat.x)) - 8 : 0;
  const top = seats.length ? Math.min(...seats.map(seat => seat.y)) - 8 : 0;
  const width = seats.length ? Math.max(...seats.map(seat => seat.x + DESK_WIDTH)) - left + 8 : ROOM_WIDTH;
  const height = seats.length ? Math.max(...seats.map(seat => seat.y + DESK_HEIGHT)) - top + 8 : ROOM_HEIGHT;
  return createPortal(<section className="seating-print" aria-label="Saved chart printout">
    <style>{`@page { size: ${paper === 'a4' ? 'A4' : 'letter'} landscape; margin: 10mm; }`}</style>
    <header><h1>{chart.name}</h1><p>{chart.className}</p><p className="seating-print-front">Front of classroom</p></header>
    <svg viewBox={`${left} ${top} ${width} ${height}`} preserveAspectRatio="xMidYMin meet" role="img" aria-label={`${chart.name}, ${chart.className}`} style={{ height: paper === 'a4' ? '156mm' : '150mm' }}>
      {chart.layout.seats.map((seat, index) => {
        const { lines, fontSize } = nameLayout(names.get(seat.studentId) || 'Empty', context);
        return <g key={seat.id} transform={`translate(${seat.x} ${seat.y})`}><rect width={DESK_WIDTH} height={DESK_HEIGHT} rx="4" fill="white" stroke="#222" strokeWidth="1.5" /><text x="6" y="13" fontSize="11">{index + 1}</text><text x={DESK_WIDTH / 2} y={18 + fontSize} textAnchor="middle" fontSize={fontSize}>{lines.map((line, at) => <tspan key={at} x={DESK_WIDTH / 2} dy={at ? fontSize + 1 : 0}>{line}</tspan>)}</text></g>;
      })}
    </svg>
  </section>, document.body);
}
