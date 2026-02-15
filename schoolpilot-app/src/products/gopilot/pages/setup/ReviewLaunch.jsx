import React from 'react';
import { Users, School, Car, Bus, PersonStanding, Clock, CheckCircle2, AlertCircle, ChevronRight } from 'lucide-react';

export default function ReviewLaunch({ students, homerooms, onNavigate }) {
  const dismissalTypes = [
    { id: 'car', label: 'Car Riders', icon: Car },
    { id: 'bus', label: 'Bus Riders', icon: Bus },
    { id: 'walker', label: 'Walkers', icon: PersonStanding },
    { id: 'afterschool', label: 'After School', icon: Clock },
  ];

  // Dynamic checklist computations
  const totalStudents = students.length;
  const assignedStudents = students.filter(s => s.homeroom).length;
  const unassignedStudents = totalStudents - assignedStudents;
  const busRiders = students.filter(s => s.dismissalType === 'bus');
  const busRidersWithRoute = busRiders.filter(s => s.busRoute);

  const checklist = [
    {
      label: 'Add students',
      tab: 'roster',
      done: totalStudents > 0,
      detail: totalStudents > 0
        ? `${totalStudents} student${totalStudents !== 1 ? 's' : ''} added`
        : 'No students added yet',
    },
    {
      label: 'Create homerooms',
      tab: 'homerooms',
      done: homerooms.length > 0,
      detail: homerooms.length > 0
        ? `${homerooms.length} homeroom${homerooms.length !== 1 ? 's' : ''} created`
        : 'No homerooms created yet',
    },
    {
      label: 'Assign students to homerooms',
      tab: 'assign',
      done: totalStudents > 0 && unassignedStudents === 0,
      detail: totalStudents === 0
        ? 'Add students first'
        : unassignedStudents === 0
          ? 'All students assigned'
          : `${unassignedStudents} student${unassignedStudents !== 1 ? 's' : ''} unassigned`,
    },
    {
      label: 'Set dismissal types',
      tab: 'dismissal',
      done: totalStudents > 0,
      detail: totalStudents > 0
        ? `${students.filter(s => s.dismissalType === 'car').length} car, ${busRiders.length} bus, ${students.filter(s => s.dismissalType === 'walker').length} walker, ${students.filter(s => s.dismissalType === 'afterschool').length} after school`
        : 'Add students first',
    },
    ...(busRiders.length > 0 ? [{
      label: 'Assign bus routes',
      tab: 'bus-assignments',
      done: busRidersWithRoute.length === busRiders.length,
      detail: busRidersWithRoute.length === busRiders.length
        ? `All ${busRiders.length} bus rider${busRiders.length !== 1 ? 's' : ''} have routes`
        : `${busRiders.length - busRidersWithRoute.length} of ${busRiders.length} bus rider${busRiders.length !== 1 ? 's' : ''} missing a route`,
    }] : []),
  ];

  const completedCount = checklist.filter(c => c.done).length;
  const allDone = completedCount === checklist.length;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-bold text-gray-900 dark:text-white">Setup Review</h2>
        <p className="text-gray-500 dark:text-slate-400 text-sm">Overview of your school configuration.</p>
      </div>

      <div className="grid md:grid-cols-2 gap-6">
        <div className="bg-white dark:bg-slate-900 rounded-xl border dark:border-slate-700 p-6">
          <h3 className="font-semibold mb-4 flex items-center gap-2 dark:text-white">
            <Users className="w-5 h-5 text-indigo-600 dark:text-indigo-400" /> Students
          </h3>
          <div className="space-y-3">
            <div className="flex justify-between"><span className="text-gray-500 dark:text-slate-400">Total</span><span className="font-semibold dark:text-white">{students.length}</span></div>
            <div className="flex justify-between"><span className="text-gray-500 dark:text-slate-400">Assigned</span><span className="font-semibold dark:text-white">{assignedStudents}</span></div>
            <div className="flex justify-between">
              <span className="text-gray-500 dark:text-slate-400">Unassigned</span>
              <span className={`font-semibold ${unassignedStudents > 0 ? 'text-yellow-600 dark:text-yellow-400' : 'text-green-600'}`}>
                {unassignedStudents}
              </span>
            </div>
          </div>
        </div>

        <div className="bg-white dark:bg-slate-900 rounded-xl border dark:border-slate-700 p-6">
          <h3 className="font-semibold mb-4 flex items-center gap-2 dark:text-white">
            <School className="w-5 h-5 text-indigo-600 dark:text-indigo-400" /> Homerooms
          </h3>
          <div className="space-y-2">
            {homerooms.map(hr => (
              <div key={hr.id} className="flex justify-between text-sm">
                <span className="dark:text-slate-300">{hr.teacher || hr.name} - Grade {hr.grade}</span>
                <span className="px-2 py-0.5 bg-blue-100 dark:bg-blue-900/30 text-blue-800 dark:text-blue-400 rounded-full text-xs font-medium">
                  {students.filter(s => s.homeroom === hr.id).length} students
                </span>
              </div>
            ))}
            {homerooms.length === 0 && <p className="text-sm text-gray-400 dark:text-slate-500">No homerooms created</p>}
          </div>
        </div>

        <div className="bg-white dark:bg-slate-900 rounded-xl border dark:border-slate-700 p-6">
          <h3 className="font-semibold mb-4 flex items-center gap-2 dark:text-white">
            <Car className="w-5 h-5 text-indigo-600 dark:text-indigo-400" /> Dismissal Breakdown
          </h3>
          <div className="space-y-3">
            {dismissalTypes.map(type => {
              const Icon = type.icon;
              return (
                <div key={type.id} className="flex justify-between items-center">
                  <span className="text-gray-500 dark:text-slate-400 flex items-center gap-2"><Icon className="w-4 h-4" /> {type.label}</span>
                  <span className="font-semibold dark:text-white">{students.filter(s => s.dismissalType === type.id).length}</span>
                </div>
              );
            })}
          </div>
        </div>

        <div className="bg-white dark:bg-slate-900 rounded-xl border dark:border-slate-700 p-6">
          <h3 className="font-semibold mb-4 flex items-center justify-between dark:text-white">
            <span className="flex items-center gap-2">
              <CheckCircle2 className="w-5 h-5 text-indigo-600 dark:text-indigo-400" /> Setup Checklist
            </span>
            <span className={`text-sm font-medium px-2 py-0.5 rounded-full ${
              allDone
                ? 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400'
                : 'bg-yellow-100 dark:bg-yellow-900/30 text-yellow-700 dark:text-yellow-400'
            }`}>
              {completedCount}/{checklist.length}
            </span>
          </h3>
          <div className="space-y-2">
            {checklist.map((item) => (
              <button
                key={item.tab}
                onClick={() => onNavigate?.(item.tab)}
                className="w-full flex items-center gap-3 p-2.5 rounded-lg text-left hover:bg-gray-50 dark:hover:bg-slate-800 transition-colors group"
              >
                {item.done ? (
                  <CheckCircle2 className="w-5 h-5 text-green-500 flex-shrink-0" />
                ) : (
                  <AlertCircle className="w-5 h-5 text-yellow-500 flex-shrink-0" />
                )}
                <div className="flex-1 min-w-0">
                  <p className={`text-sm font-medium ${item.done ? 'text-gray-500 dark:text-slate-400' : 'text-gray-900 dark:text-white'}`}>
                    {item.label}
                  </p>
                  <p className={`text-xs ${item.done ? 'text-gray-400 dark:text-slate-500' : 'text-yellow-600 dark:text-yellow-400'}`}>
                    {item.detail}
                  </p>
                </div>
                <ChevronRight className="w-4 h-4 text-gray-300 dark:text-slate-600 group-hover:text-gray-500 dark:group-hover:text-slate-400 flex-shrink-0" />
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
