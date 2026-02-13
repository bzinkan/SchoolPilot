import React from 'react';
import { Users, School, Car, Bus, PersonStanding, Clock, Check, CheckCircle2 } from 'lucide-react';

export default function ReviewLaunch({ students, homerooms, onLaunch }) {
  const dismissalTypes = [
    { id: 'car', label: 'Car Riders', icon: Car },
    { id: 'bus', label: 'Bus Riders', icon: Bus },
    { id: 'walker', label: 'Walkers', icon: PersonStanding },
    { id: 'afterschool', label: 'After School', icon: Clock },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-bold text-gray-900">Review & Launch</h2>
        <p className="text-gray-500 text-sm">Review your setup and launch GoPilot.</p>
      </div>

      <div className="grid md:grid-cols-2 gap-6">
        <div className="bg-white rounded-xl border p-6">
          <h3 className="font-semibold mb-4 flex items-center gap-2">
            <Users className="w-5 h-5 text-indigo-600" /> Students
          </h3>
          <div className="space-y-3">
            <div className="flex justify-between"><span className="text-gray-500">Total</span><span className="font-semibold">{students.length}</span></div>
            <div className="flex justify-between"><span className="text-gray-500">Assigned</span><span className="font-semibold">{students.filter(s => s.homeroom).length}</span></div>
            <div className="flex justify-between">
              <span className="text-gray-500">Unassigned</span>
              <span className={`font-semibold ${students.filter(s => !s.homeroom).length > 0 ? 'text-yellow-600' : 'text-green-600'}`}>
                {students.filter(s => !s.homeroom).length}
              </span>
            </div>
          </div>
        </div>

        <div className="bg-white rounded-xl border p-6">
          <h3 className="font-semibold mb-4 flex items-center gap-2">
            <School className="w-5 h-5 text-indigo-600" /> Homerooms
          </h3>
          <div className="space-y-2">
            {homerooms.map(hr => (
              <div key={hr.id} className="flex justify-between text-sm">
                <span>{hr.teacher || hr.name} - Grade {hr.grade}</span>
                <span className="px-2 py-0.5 bg-blue-100 text-blue-800 rounded-full text-xs font-medium">
                  {students.filter(s => s.homeroom === hr.id).length} students
                </span>
              </div>
            ))}
            {homerooms.length === 0 && <p className="text-sm text-gray-400">No homerooms created</p>}
          </div>
        </div>

        <div className="bg-white rounded-xl border p-6">
          <h3 className="font-semibold mb-4 flex items-center gap-2">
            <Car className="w-5 h-5 text-indigo-600" /> Dismissal Breakdown
          </h3>
          <div className="space-y-3">
            {dismissalTypes.map(type => {
              const Icon = type.icon;
              return (
                <div key={type.id} className="flex justify-between items-center">
                  <span className="text-gray-500 flex items-center gap-2"><Icon className="w-4 h-4" /> {type.label}</span>
                  <span className="font-semibold">{students.filter(s => s.dismissalType === type.id).length}</span>
                </div>
              );
            })}
          </div>
        </div>

        <div className="bg-white rounded-xl border p-6">
          <h3 className="font-semibold mb-4 flex items-center gap-2">
            <CheckCircle2 className="w-5 h-5 text-indigo-600" /> Next Steps
          </h3>
          <div className="space-y-3 text-sm">
            <div className="flex items-start gap-2"><Check className="w-4 h-4 text-green-500 mt-0.5" /><span>Send parent invitation emails</span></div>
            <div className="flex items-start gap-2"><Check className="w-4 h-4 text-green-500 mt-0.5" /><span>Train staff on the dismissal dashboard</span></div>
            <div className="flex items-start gap-2"><Check className="w-4 h-4 text-green-500 mt-0.5" /><span>Run a test dismissal</span></div>
          </div>
        </div>
      </div>

      <div className="bg-indigo-50 rounded-xl border border-indigo-200 p-6 flex items-center justify-between">
        <div>
          <h3 className="font-semibold text-indigo-900">Ready to Launch!</h3>
          <p className="text-sm text-indigo-700">Your school is configured and ready to start using GoPilot.</p>
        </div>
        <button onClick={onLaunch} className="flex items-center gap-2 px-6 py-3 bg-indigo-600 text-white rounded-lg font-medium hover:bg-indigo-700">
          <CheckCircle2 className="w-5 h-5" /> Launch GoPilot
        </button>
      </div>
    </div>
  );
}
