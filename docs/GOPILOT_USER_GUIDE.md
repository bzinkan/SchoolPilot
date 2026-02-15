# GoPilot User Guide

**Version 1.0** | School Dismissal Management System

---

## Table of Contents

1. [Overview](#overview)
2. [Getting Started](#getting-started)
3. [Setup Wizard](#setup-wizard)
4. [Dismissal Dashboard (Office View)](#dismissal-dashboard-office-view)
5. [Teacher View](#teacher-view)
6. [Parent App](#parent-app)
7. [Family Groups & Car Numbers](#family-groups--car-numbers)
8. [Bus Dismissal](#bus-dismissal)
9. [Walker Dismissal](#walker-dismissal)
10. [Reports & Activity Log](#reports--activity-log)
11. [Data & Privacy](#data--privacy)
12. [Troubleshooting](#troubleshooting)

---

## Overview

GoPilot is a comprehensive school dismissal management system that streamlines how schools organize student pickups and handoffs. It connects office staff, teachers, and parents in real-time to manage car pickups, bus departures, walker releases, and after-school programs.

### Key Features
- **Real-Time Queue Management** - Track every student from check-in to pickup
- **Multiple Dismissal Types** - Car riders, bus students, walkers, and after-school programs
- **Car Number Check-In** - Office staff enters car numbers; students are automatically queued
- **Parent App** - Parents check in via app with real-time status updates
- **Teacher Notifications** - Teachers see which students are called in real-time
- **QR Code Check-In** - Parents scan QR codes for instant check-in
- **Bus Route Management** - Organize students by bus route with batch dismissal
- **Custody Alerts** - Flag restricted pickups for student safety
- **Family Groups** - Link siblings under one car number for efficient pickup
- **Live WebSocket Updates** - All views update instantly across office, teachers, and parents

---

## Getting Started

### For School Admins

1. **Login** to SchoolPilot at your school's URL
2. Navigate to **GoPilot** from the product switcher
3. Complete the **Setup Wizard** to configure your school:
   - Add staff members
   - Import student roster
   - Create homerooms
   - Set up bus routes
   - Assign car numbers via family groups
   - Configure dismissal types
4. Launch when ready

### For Office Staff

1. **Login** to SchoolPilot with your credentials
2. Navigate to **GoPilot**
3. You'll see the **Dismissal Dashboard**
4. Click **Start Dismissal** to begin a session
5. Enter car numbers, bus numbers, or release walkers as parents arrive

### For Teachers

1. **Login** to SchoolPilot with your credentials
2. Navigate to **GoPilot**
3. You'll see the **Teacher View** for your assigned homeroom
4. When students are called, their names appear in your called list
5. Dismiss students from your classroom as they're called

### For Parents

1. Receive an **invite link** or **QR code** from your school
2. **Register** an account and link your children
3. Use the **Parent App** to:
   - Check in when you arrive for pickup
   - See real-time status of your child's dismissal
   - Request changes to dismissal type for the day

---

## Setup Wizard

The Setup Wizard guides administrators through the complete configuration. Access it from the GoPilot navigation.

### Staff Manager

Add and manage staff members who will use GoPilot.

**Add Staff:**
1. Click **Add Staff**
2. Enter: First Name, Last Name, Email, Role
3. Available roles:
   - **Admin** - Full access to setup and dashboard
   - **Office Staff** - Operate the dismissal dashboard
   - **Teacher** - Classroom view and student release
4. Click Save

### Student Roster

Import your student roster into GoPilot.

**Manual Entry:**
1. Click **Add Student**
2. Enter: First Name, Last Name, Grade
3. Click Save

**CSV Import:**
1. Click **Import CSV**
2. Upload a CSV file with columns: First Name, Last Name, Grade
3. Review the parsed data
4. Confirm import

**Import from Google Classroom:**
1. Click **Import from Google**
2. Select organizational units
3. Map grade levels
4. Import students

**QR Code Printing:**
- Each student gets a unique linking code
- Print QR codes for parents to scan and link their children

### Homeroom Manager

Create homerooms and assign teachers and students.

**Create a Homeroom:**
1. Click **Add Homeroom**
2. Enter: Homeroom Name, Grade Level, Room Number
3. Assign a Teacher
4. Click Save

**Assign Students:**
1. Select a homeroom
2. Add students from the unassigned list
3. Students can only belong to one homeroom

### Bus Assignments

Set up bus routes and assign students.

**Create a Bus Route:**
1. Click **Add Bus Route**
2. Enter: Route Number, Departure Time (optional)
3. Click Save

**Assign Students to Routes:**
- **Manual:** Select a route, then add students individually
- **CSV Import:** Upload a CSV mapping students to bus numbers (uses fuzzy name matching)

**View Bus Summary:**
- See all routes with student counts
- Click a route to view its assigned students

### Car Numbers (Family Groups)

Organize car-rider families with car numbers for efficient pickup.

**Create a Family Group:**
1. Click **Add Family Group**
2. Enter: Car Number, Family Name (optional)
3. Add students to the group (siblings ride together)
4. An **invite token** is automatically generated

**Auto-Number Remaining:**
- Click **Auto-Number Remaining** to automatically assign car numbers to unassigned car-rider students
- Groups are created with family names based on student last names

**Share with Parents:**
- Each family group has a **QR code** and **invite link**
- Click the **QR** button on a group to reveal the code
- Parents scan the QR or visit the link to register and claim the group
- Once claimed, the parent's name appears on the dismissal queue instead of "Car #X"

### Dismissal Config

Set the dismissal type for each student.

**Dismissal Types:**
- **Car** - Parent picks up by car (uses car number)
- **Bus** - Student rides a specific bus route
- **Walker** - Student walks home or is released to walk
- **After-School** - Student stays for after-school program

**Set Dismissal Types:**
1. Filter by homeroom (optional)
2. For each student, select their dismissal type
3. If Bus, also assign their bus number
4. Changes save automatically

**Bulk Set by Homeroom:**
- Select a homeroom
- Set all students in that homeroom to the same type at once

### Parents Tab

Manage parent accounts and relationships.

- View registered parents and their linked children
- See which family groups have been claimed by parents
- Manage authorized pickup persons

### School Settings

Configure school-wide GoPilot settings.

**Pickup Zones:**
- Create physical zones (A, B, C, etc.) for organizing car pickup flow
- Add/edit/remove zones
- Zones appear on the dismissal dashboard

**Other Settings:**
- School timezone
- Enable/disable QR code check-in
- Custom change request warning message
- Notification preferences

### Review & Launch

Final verification before going live:
- Summary of students, homerooms, bus routes
- Verification checks for completeness
- **Launch** button to activate GoPilot

---

## Dismissal Dashboard (Office View)

The Dismissal Dashboard is the central command center for managing daily dismissals. Office staff use this view to check in students and manage the queue.

### Starting a Session

1. Click **Start Dismissal** to begin a new session
2. The session tracks all dismissal activity for the day
3. Only one session can be active per school per day

**Session Controls:**
- **Start** - Begin the dismissal session
- **Pause** - Temporarily pause (e.g., weather delay)
- **Resume** - Continue after pause
- **End** - Complete the session for the day

### Car Number Check-In

The primary check-in method for car riders:

1. **Enter Car Number** using the on-screen number pad or keyboard
2. System looks up the **family group** for that car number
3. All students in the group are added to the queue
4. Guardian name displays (parent name if group is claimed, family name otherwise)

### QR Code Check-In

For parents who have registered via the app:

1. Parent shows their **QR code** on their phone
2. Office staff scans it (or parent scans at a station)
3. Students are automatically checked in

### Bus Dismissal

1. Enter the **bus number**
2. All students assigned to that bus route are checked in
3. Teachers are notified that bus students are called

### Walker Release

1. Click **Release Walkers**
2. Select a grade level or homeroom
3. All walkers in that group are batch-dismissed
4. Teachers are notified

### Queue Management

The queue shows all checked-in students with real-time status:

**Student Statuses:**
- **Waiting** - Student is in the queue, not yet called to leave class
- **Called** - Teacher has been notified, student is being released
- **Released** - Teacher has dismissed the student from class
- **Dismissed** - Student has been picked up (complete)
- **On Hold** - Temporarily held (custody issue, parent not found, etc.)

**Queue Tabs:**
- **Queue** - All students currently in the dismissal process
- **Dismissed** - Students already picked up (completed)

**Queue Actions:**
- Click a student to change their status
- Batch dismiss all students from the same car/family
- Move students between statuses

### Pickup Zones

If configured, assign arriving cars to physical zones:
- Zone assignments help organize traffic flow
- Parents see their assigned zone in the app
- Visual zone status on the dashboard

### Real-Time Stats

The dashboard header shows live metrics:
- **Total Dismissed** - Students picked up today
- **In Queue** - Students waiting
- **In Transit** - Students moving from class to pickup
- **On Hold** - Students temporarily held
- **Avg Wait Time** - Average time from check-in to pickup (mm:ss)

### Sound Alerts

Toggle sound notifications on/off:
- Alert sounds when new students are checked in
- Helps office staff stay aware during busy periods

### Custody Alerts

A banner displays at the top if any students in the queue have custody restrictions:
- Court orders
- Restricted pickup persons
- Special instructions from administration

---

## Teacher View

Teachers see a classroom-focused interface for releasing students during dismissal.

### Three-Panel Layout

**Left Panel - Class Roster:**
- All students in your homeroom
- Color-coded status indicators:
  - **Gray** - In Class (not yet called)
  - **Red** - Called (waiting for teacher to release)
  - **Green** - In Transit (released from class, heading to pickup)
  - **Blue** - Picked Up (dismissed)

**Center Panel - Called Students:**
- Students grouped by guardian/car number
- Shows who is being picked up together (siblings)
- **Dismiss** button to release students from class
- Batch dismiss all students in a group at once

**Right Panel - Announcements:**
- Real-time announcements from the office:
  - Bus calls (e.g., "Bus 42 is loading")
  - Walker releases (e.g., "3rd Grade walkers released")
  - Car pickup activity
- Daily summary stats

### Teacher Actions

1. **Wait for calls** - Students appear in the center panel when checked in by office
2. **Dismiss students** - Click the Dismiss button to release them from class
3. **Batch dismiss** - Release all students in a group at once
4. **Monitor status** - See real-time updates as students are picked up

### Sound Alerts

Toggle volume alerts:
- Audio notification when new students are called for your class
- Helps teachers notice calls during busy classroom time

---

## Parent App

The Parent App gives parents real-time visibility into the dismissal process and the ability to check in remotely.

### Registration & Setup

**Step 1: Register**
1. Receive an invite link or QR code from your school
2. Visit the link and create an account
3. Enter your information (name, email, phone)

**Step 2: Link Children**
1. Enter the **student linking code** provided by the school
2. Select your relationship (Parent, Guardian, Grandparent, Other)
3. Repeat for each child

**Step 3: Add Authorized Pickups** (Optional)
- Add other people authorized to pick up your children
- Enter their name, relationship, and phone number
- School must approve authorized pickups

**Step 4: Set Preferences**
- **Notifications:** Toggle push, SMS, or email notifications
- **Dismissal Updates:** Get notified when your child is released
- **Change Confirmations:** Get notified when change requests are approved
- **Check-In Method:** Choose App or QR code

### Home Screen

The parent home screen shows:
- **Child Information** - Name, grade, homeroom, dismissal type
- **Car Number** - Your assigned car number (if applicable)
- **School Time** - Current time and dismissal time
- **Quick Actions:**
  - Check In
  - Change Today's Pickup
  - View History

### Checking In

When you arrive at school for pickup:

1. Open the Parent App
2. Tap **Check In**
3. Your children are added to the dismissal queue
4. See real-time status updates:
   - **In Queue** - Your position number and estimated wait time
   - **Called** - "Proceed to Zone B" (or your assigned zone)
   - **Complete** - Pickup successful

### Changing Dismissal Type

Need to change how your child gets home today?

1. Tap **Change Today's Pickup**
2. Select the new dismissal type:
   - Car (default)
   - Bus (enter bus number)
   - Walker
   - After-School
3. Add an optional note to the school
4. Submit the request
5. School reviews and approves/denies
6. You're notified of the decision

### QR Code

Your account has a unique QR code:
- Display it at the pickup line for scanning
- Office staff or automated scanners read it
- Instant check-in without entering car numbers

### Pickup History

View past dismissal records:
- Date and time of each pickup
- Child name
- Wait time
- Pickup method

### Authorized Pickups

Manage who can pick up your children:
- Add authorized persons (grandparents, family friends, etc.)
- Track approval status (Pending/Approved)
- Remove authorization at any time

---

## Family Groups & Car Numbers

Family groups are the foundation of car dismissal in GoPilot. They link car numbers to students and optionally to parent accounts.

### How Family Groups Work

1. **Admin creates a family group** with a car number (e.g., Car #142)
2. **Students are assigned** to the group (typically siblings)
3. When office enters **car number 142**, all students in that group are checked in
4. **Optional:** A parent claims the group via invite link, enabling app check-in

### Creating Family Groups

**Manual Creation:**
1. Go to Setup → Car Numbers
2. Click **Add Family Group**
3. Enter car number and optional family name
4. Add students to the group

**Auto-Assign:**
1. Click **Auto-Number Remaining**
2. System automatically creates groups for unassigned car-rider students
3. Groups are named by student last name (e.g., "Smith Family")
4. Car numbers are assigned sequentially

### Parent Enrollment

Each family group has an **invite token** and **QR code**:

1. Admin clicks **QR** on a family group card
2. QR code and invite link are revealed
3. Share with the parent (print, email, or show)
4. Parent scans the QR or visits the link
5. Parent registers and the group is **claimed**
6. The parent's name now appears on the dismissal queue instead of "Car #142"
7. Parent can use the app to check in

### Unclaimed Groups

Groups that haven't been claimed by a parent still work:
- Office enters the car number manually
- Queue shows the family name or "Car #X"
- All students in the group are checked in

---

## Bus Dismissal

### How Bus Dismissal Works

1. **Setup:** Assign students to bus routes in the Setup Wizard
2. **During Dismissal:** Office enters a bus number on the dashboard
3. **All students** on that route are checked in at once
4. **Teachers notified:** An announcement appears in the Teacher View
5. **Teachers dismiss:** Bus students are released from class
6. **Office confirms departure:** Bus students are marked as dismissed

### Bus Route Management

**Create Routes:**
- Go to Setup → Bus Assignments
- Add route numbers and optional departure times

**Assign Students:**
- Manually assign students to routes
- Or import via CSV with bus number column (fuzzy name matching)

**View Routes:**
- See all routes with student counts
- Click to expand and view students on each route

---

## Walker Dismissal

### How Walker Dismissal Works

1. **Setup:** Set student dismissal type to "Walker" in Dismissal Config
2. **During Dismissal:** Office clicks **Release Walkers**
3. **Select group:** Choose a grade level or homeroom
4. **Batch release:** All walkers in the selected group are dismissed
5. **Teachers notified:** Announcement appears in Teacher View
6. **Teachers release:** Walker students leave class

### Walker Zones (Optional)

If configured, walkers can be organized by geographic zones for safety:
- Create walker zones in School Settings
- Assign students to zones
- Release by zone for organized departure

---

## Reports & Activity Log

GoPilot maintains a complete activity log for every dismissal session.

### Session History

- View past dismissal sessions with date, start/end time, and total dismissed
- Drill into any session to see the full queue history

### Activity Log

Every action is logged:
- Student check-ins (who, when, method)
- Status changes (called, released, dismissed)
- Change requests (from parent, approved/denied)
- Who performed each action

### Metrics

- Total students dismissed per session
- Average wait time
- Peak check-in times
- Dismissal type breakdown (car, bus, walker, after-school)

---

## Data & Privacy

### What Data is Collected

**Per Dismissal Event:**
- Student ID and name
- Dismissal type and method
- Check-in time, called time, release time, pickup time
- Guardian/parent name
- Car number or bus route
- Pickup zone assignment
- Who performed each action

**Parent Accounts:**
- Name, email, phone number
- Linked children
- Authorized pickup persons
- Notification preferences

**NOT Collected:**
- GPS or location tracking of parents
- Vehicle information beyond car number
- Personal communications
- Financial information

### Privacy Design

- **Role-Based Access** - Teachers see only their homeroom; parents see only their children
- **Custody Alerts** - Restricted pickup persons are flagged for student safety
- **Audit Trail** - Every action is logged with who, what, and when
- **Secure Communication** - All data transmitted over HTTPS/WSS
- **Minimal Storage** - Only dismissal-related data is stored

### FERPA/COPPA Compliance

GoPilot is designed to support compliance with:
- **FERPA** (Family Educational Rights and Privacy Act)
- **COPPA** (Children's Online Privacy Protection Act)
- **State education privacy laws**

**School Responsibilities:**
1. Maintain accurate custody and pickup authorization records
2. Review and approve authorized pickup persons
3. Configure custody alerts for restricted situations
4. Follow local/state privacy regulations
5. Ensure parent registration data is protected

---

## Troubleshooting

### Common Issues

#### Car Number Not Found

**Possible Causes:**
1. Family group not created for that car number
2. Car number entered incorrectly
3. Students not assigned to the family group

**Solutions:**
1. Go to Setup → Car Numbers and verify the group exists
2. Double-check the car number with the parent
3. Create a new family group if needed

#### Teacher Not Seeing Called Students

**Possible Causes:**
1. Teacher not assigned to a homeroom
2. WebSocket connection lost
3. Students in a different homeroom

**Solutions:**
1. Check Setup → Homeroom Manager for teacher assignment
2. Refresh the page to reconnect
3. Verify students are in the correct homeroom

#### Parent Can't Check In

**Possible Causes:**
1. No active dismissal session
2. Parent hasn't linked children
3. Family group not claimed

**Solutions:**
1. Office must start a dismissal session first
2. Parent needs to link children using student codes
3. Parent needs to claim a family group via invite link

#### Students Not Appearing in Queue

**Possible Causes:**
1. No dismissal session active
2. Student doesn't have a dismissal type set
3. Student not assigned to a homeroom

**Solutions:**
1. Start a dismissal session from the dashboard
2. Check Setup → Dismissal Config for each student
3. Check Setup → Homeroom Manager for student assignment

#### Bus Students Not Checking In

**Possible Causes:**
1. Students not assigned to a bus route
2. Wrong bus number entered
3. Students' dismissal type not set to "Bus"

**Solutions:**
1. Check Setup → Bus Assignments
2. Verify the bus route number
3. Check Setup → Dismissal Config

#### Real-Time Updates Not Working

**Possible Causes:**
1. WebSocket connection dropped
2. Network connectivity issues
3. Browser tab in background (throttled)

**Solutions:**
1. Refresh the browser page
2. Check internet connection
3. Keep the GoPilot tab in the foreground during dismissal

### Getting Help

**Office Staff:**
- Contact your school administrator
- Check this user guide for common solutions

**Teachers:**
- Contact the office if students aren't being called
- Refresh the page if updates seem stalled

**Parents:**
- Contact the school office for account or linking issues
- Check notification settings if not receiving updates

---

## Best Practices

### For School Admins

- **Complete Setup Before Launch** - Ensure all students have homerooms, dismissal types, and bus/car assignments before the first live dismissal
- **Print QR Codes** - Generate and distribute parent invite QR codes at back-to-school events
- **Test First** - Run a practice dismissal with staff before going live with parents
- **Review Custody Alerts** - Keep custody restrictions current and review regularly
- **Train All Roles** - Ensure office staff, teachers, and parents understand their interfaces

### For Office Staff

- **Start Sessions On Time** - Begin the dismissal session before the first parent arrives
- **Use Sound Alerts** - Keep audio on to hear new check-ins during busy periods
- **Watch Custody Alerts** - Review the alert banner before releasing any flagged students
- **Batch Bus Calls** - Enter bus numbers as buses arrive for efficient teacher notification
- **Monitor Wait Times** - Keep an eye on average wait times to identify bottlenecks

### For Teachers

- **Keep GoPilot Open** - Have the Teacher View open on your computer during dismissal
- **Dismiss Promptly** - Release students quickly when they're called to minimize wait times
- **Use Batch Dismiss** - Release all siblings in a group at once
- **Check Announcements** - Watch the right panel for bus calls and walker releases

### For Parents

- **Register Early** - Set up your account and link children before the first day of school
- **Add Authorized Pickups** - Pre-register anyone who might pick up your children
- **Check In On Arrival** - Use the app to check in as you enter the pickup line, not before
- **Watch Notifications** - Enable push notifications to know when your child is released
- **Update Changes Early** - Submit change requests before dismissal time if possible

---

## Technical Specifications

### System Requirements

**Dismissal Dashboard (Office):**
- Modern web browser (Chrome, Firefox, Safari, Edge)
- Internet connection (stable, low latency preferred)
- Display resolution: 1280x720 minimum
- Audio output (for sound alerts)

**Teacher View:**
- Modern web browser
- Internet connection
- Any screen size (responsive design)

**Parent App:**
- Mobile browser (Chrome, Safari) or any modern browser
- Internet connection
- Camera (for QR code display/scanning)

**Server:**
- Node.js 20+
- PostgreSQL database
- Redis (for WebSocket pub/sub)
- WebSocket support
- HTTPS/TLS certificate

### Network Requirements

**Ports:**
- 443 (HTTPS) - Dashboard and API access
- 443 (WSS) - WebSocket connections for real-time updates

**Bandwidth:**
- Minimal per client (~50 KB/s)
- Real-time updates via WebSocket (lightweight)

### Real-Time Architecture

GoPilot uses WebSocket connections for instant updates:
- **Office actions** (check-in, dismiss) broadcast to all connected teachers
- **Teacher actions** (release student) broadcast back to office and parent
- **Parent check-ins** appear instantly on the office dashboard
- All events are scoped to the school room for security

---

**Last Updated:** February 2026
**Version:** 1.0
**Copyright:** SchoolPilot Team

---

*This guide is provided for educational purposes. Schools are responsible for ensuring compliance with all applicable privacy laws and regulations.*
