# PassPilot User Guide

**Version 1.0** | Digital Hall Pass Management System

---

## Table of Contents

1. [Overview](#overview)
2. [Getting Started](#getting-started)
3. [Teacher Dashboard](#teacher-dashboard)
4. [My Class Tab](#my-class-tab)
5. [Kiosk Mode](#kiosk-mode)
6. [Reports & Analytics](#reports--analytics)
7. [Admin Setup](#admin-setup)
8. [Data & Privacy](#data--privacy)
9. [Troubleshooting](#troubleshooting)

---

## Overview

PassPilot is a digital hall pass management system designed for schools. It replaces paper-based sign-out sheets with a real-time tracking system that lets teachers issue passes, students self-checkout via kiosks, and administrators monitor pass activity across the school.

### Key Features
- **Real-Time Pass Tracking** - See which students are out of class and where they are
- **Teacher-Issued Passes** - Quick one-click pass creation from the dashboard
- **Kiosk Self-Checkout** - Students scan a badge or select their name to check out
- **Automatic Expiration** - Passes expire after a configurable duration
- **Detailed Reports** - Analytics on pass usage by student, teacher, grade, and type
- **CSV Export** - Export pass history for records
- **Google Workspace Integration** - Import teachers from Google Directory
- **Multiple Kiosk Modes** - Badge/ID scanning or simple list-based checkout

---

## Getting Started

### For School Admins

1. **Login** to SchoolPilot at your school's URL
2. Navigate to **PassPilot** from the product switcher
3. Go to **Setup** to configure teachers, students, and classes
4. Set up kiosk mode if desired

### For Teachers

1. **Login** to SchoolPilot with your credentials
2. Navigate to **PassPilot** from the product switcher
3. You'll see the **Dashboard** with your assigned classes
4. Start issuing passes from the **My Class** tab

### For Students (Kiosk Mode)

1. Go to the kiosk station set up in your school
2. **Scan your badge** or **enter your student ID**
3. Select a **destination** (Bathroom, Nurse, Office, etc.)
4. Your pass is active — return to the kiosk to check back in

---

## Teacher Dashboard

### Passes Tab

The Passes tab shows all **currently active passes** across the school in real-time.

#### What You See
- **Student Name** - Who is out of class
- **Destination** - Where they went (Bathroom, Nurse, Office, Counselor, Other Classroom, Custom)
- **Status Badge** - Active (green), Returned (gray), Expired (red)
- **Time Issued** - When the pass was created
- **Live Indicator** - Green dot showing real-time updates are active

#### Filtering Passes
- **All** - View all active passes
- **General** - Bathroom and general passes
- **Nurse** - Health office visits
- **Discipline** - Main office / discipline referrals

You can also filter by **class or grade** to see passes for specific groups.

**Update Frequency:** Every 5 seconds

---

## My Class Tab

The My Class tab is your primary workspace for managing passes in your assigned classes.

### Quick Stats

At the top of each class view:
- **Total Students** - Number of students in the class
- **Currently Out** - How many students have active passes
- **Available** - Students currently in class

### Currently Out Section

Shows students with active passes:
- **Student Name** with destination
- **Time Elapsed** - How long they've been out (updates live)
- **Mark Returned** button - Click to end the pass when the student returns

### Available Students Section

Shows students currently in class:
- **Student Name** with a dropdown menu
- Click the dropdown to issue a pass with a destination:
  - Bathroom
  - Nurse
  - Main Office
  - Counselor
  - Other Classroom
  - Custom Reason (enter your own)

### Issuing a Pass

1. Find the student in the **Available Students** list
2. Click the **dropdown arrow** next to their name
3. Select a **destination**
4. The pass is instantly created and the student moves to **Currently Out**

### Returning a Pass

1. Find the student in the **Currently Out** section
2. Click **Mark Returned**
3. The pass is ended and the student moves back to **Available**

### Multiple Classes

If you teach multiple classes, switch between them using the **grade tabs** at the top of the My Class view.

### Send to Kiosk

Click **Send to Kiosk** to push your current grade to the Simple Kiosk display, so the kiosk automatically shows the right class for student self-checkout.

---

## Kiosk Mode

PassPilot offers two kiosk modes for student self-checkout. Both run in a browser on a dedicated device (tablet, Chromebook, or computer) placed near the classroom door.

### Badge/ID Kiosk

Best for schools where students have ID badges or know their student ID numbers.

#### How It Works

1. **Scan or Enter ID** - Student scans their badge or types their student ID number
2. **Confirm Identity** - Student sees their name displayed for confirmation
3. **Select Destination** - Choose from a 6-button grid:
   - Bathroom
   - Nurse
   - Main Office
   - Counselor
   - Other Classroom
   - Custom
4. **Pass Created** - Confirmation screen appears
5. **Auto-Reset** - Screen returns to scan mode after 10 seconds

#### Checking Back In

1. **Scan or Enter ID** again
2. System detects an **active pass** for this student
3. Click **Check In** to end the pass
4. Student is marked as returned

#### Setup

- Access via URL: `your-school-url/passpilot/kiosk?school=SCHOOL_ID`
- No authentication required (public endpoint)
- Requires school ID parameter

### Simple Kiosk

Best for classroom-based setups where students select from a class list.

#### How It Works

1. **Select Grade/Class** - Choose the class from a picker (or teacher pushes it remotely)
2. **View Students** - Two sections displayed:
   - **Currently Out** - Students with active passes (with time elapsed)
   - **Available Students** - Students in class
3. **Tap to Check Out** - Tap an available student's name, then select destination
4. **Tap to Check In** - Tap a currently-out student to mark them returned

#### Remote Grade Control

Teachers can push a specific grade to the Simple Kiosk from their dashboard:
1. Go to **My Class** tab
2. Click **Send to Kiosk**
3. The kiosk automatically switches to display that class

#### Setup

- Access via URL: `your-school-url/passpilot/kiosk-simple?school=SCHOOL_ID`
- Real-time polling keeps the display current
- No authentication required

### Kiosk Configuration

Admins can configure kiosk settings:
- **Enable/Disable** kiosk mode school-wide
- **Default Pass Duration** - How long before passes auto-expire (default: 5 minutes)
- **Kiosk Name** - Identifier for the kiosk location (e.g., "Room 204", "Main Hall")

---

## Reports & Analytics

Access reports from the **Reports** tab on the dashboard.

### Date Range Filters

- **Today** - Current day's pass activity
- **This Week** - Monday through today
- **This Month** - First of the month through today
- **Custom** - Select specific start and end dates

### Filters

- **Grade** - Filter by specific class or grade level
- **Teacher** - Filter by issuing teacher
- **Pass Type** - Filter by destination (General, Nurse, Office, etc.)

### Pass Type Breakdown

Visual summary cards showing counts by type:
- General/Bathroom passes
- Nurse/Health visits
- Main Office visits
- Other types

### Key Statistics

- **Total Passes** - Number of passes issued in the date range
- **Average Duration** - Average time students are out
- **Peak Hour** - Busiest hour for pass activity
- **Unique Students** - Number of distinct students who had passes

### Today's Activity

A live feed of today's pass activity showing:
- Student name
- Destination
- Checkout time
- Return time
- Duration
- Delete option (for erroneous entries)

### CSV Export

1. Set your desired date range and filters
2. Click **Export to CSV**
3. Download contains full pass history with:
   - Student name
   - Destination
   - Checkout time
   - Return time
   - Duration
   - Issuing teacher
   - Grade/Class

---

## Admin Setup

Access the Setup panel from the PassPilot navigation (admin accounts only).

### Teachers Tab

**Add Teachers:**
1. Click **Add Teacher**
2. Enter: Email, First Name, Last Name, Password
3. Click Save

**Import from Google Workspace:**
1. Click **Import from Google**
2. Navigate organizational units to find teachers
3. Select teachers to import
4. Click Import

**Remove Teachers:**
- Click the delete button next to a teacher's name

### Student Roster Tab

**Add Students Individually:**
1. Click **Add Student**
2. Enter: First Name, Last Name, Grade, Student ID (optional)
3. Click Save

**Bulk Import:**
1. Click **Bulk Add**
2. Paste student data (one per line, comma or tab separated)
3. System parses names, grades, and IDs
4. Review and confirm

### Classes Tab

**Create a Class:**
1. Click **Create Class**
2. Enter class name (e.g., "3rd Grade - Room 204")
3. Select grade level (K-12)
4. Click Save

**Edit/Delete Classes:**
- Click Edit to rename a class
- Click Delete to remove (students are unassigned, not deleted)

### Class Assignments Tab

Assign teachers to classes:
1. Select a teacher
2. Check the classes they teach
3. Save assignments

Teachers will only see their assigned classes in the My Class tab.

### Settings Tab

Configure school-wide PassPilot settings:
- **Kiosk Mode** - Enable/disable
- **Pass Duration** - Default pass length in minutes
- **Google Workspace** - Connection settings for teacher import

---

## Data & Privacy

### What Data is Collected

**Per Pass:**
- Student ID and name
- Destination/reason
- Issuing teacher (or "kiosk" for self-checkout)
- Issue time, return time, and duration
- Grade/class association

**NOT Collected:**
- Student location tracking
- Personal communications
- Device information
- Browsing activity

### Privacy Design

- **Minimal Data** - Only pass activity data is stored
- **Role-Based Access** - Teachers see only their assigned classes
- **No Tracking** - No GPS, no device monitoring, no surveillance
- **Educational Purpose** - Data used only for managing student movement

### FERPA/COPPA Compliance

PassPilot is designed to support compliance with:
- **FERPA** (Family Educational Rights and Privacy Act)
- **COPPA** (Children's Online Privacy Protection Act)
- **State education privacy laws**

**School Responsibilities:**
1. Ensure pass data is used for educational purposes only
2. Maintain appropriate data retention practices
3. Restrict access to authorized school personnel
4. Follow local/state privacy regulations

---

## Troubleshooting

### Common Issues

#### Student Not Appearing in Class List

**Possible Causes:**
1. Student not added to the roster
2. Student not assigned to a class
3. Teacher not assigned to that class

**Solutions:**
1. Go to Setup → Student Roster and verify the student exists
2. Check Setup → Classes to verify student is in a class
3. Check Setup → Class Assignments to verify your assignment

#### Kiosk Not Loading

**Possible Causes:**
1. Missing school ID in URL
2. Kiosk mode not enabled
3. Network connectivity

**Solutions:**
1. Verify the URL includes `?school=YOUR_SCHOOL_ID`
2. Ask admin to enable kiosk mode in Settings
3. Check internet connection on the kiosk device

#### Pass Not Auto-Expiring

**Possible Causes:**
1. Duration set to 0 (no expiration)
2. Server-side expiration check timing

**Solutions:**
1. Check Settings → Pass Duration (should be > 0)
2. Passes are checked for expiration on each data refresh

#### Cannot See Other Teachers' Passes

**Expected Behavior:**
- In **My Class** tab, you only see your assigned classes
- In **Passes** tab, you can see all active passes school-wide
- Admins can see everything in all views

#### Export Not Downloading

**Solutions:**
1. Check browser popup/download permissions
2. Try a different browser
3. Verify you have passes in the selected date range

### Getting Help

**Teachers:**
- Contact your school administrator
- Check this user guide for common solutions

**School Admins:**
- Review Settings configuration
- Check teacher and student assignments
- Contact SchoolPilot support

---

## Best Practices

### For Teachers

- **Be Consistent** - Use the system for every pass to build accurate data
- **Review Reports** - Check weekly reports to identify patterns (frequent flyers, peak times)
- **Use Custom Reasons** - When standard destinations don't fit, add a custom reason for better tracking
- **Return Passes Promptly** - Mark students returned as soon as they're back to keep data accurate
- **Kiosk Placement** - Place the kiosk device near the classroom door for easy access

### For Admins

- **Complete Roster First** - Import all students and classes before going live
- **Assign All Teachers** - Ensure every teacher is assigned to their classes
- **Set Appropriate Duration** - 5 minutes is standard; adjust based on your school's needs
- **Review Reports Monthly** - Use analytics to identify trends and policy needs
- **Train Teachers** - Walk through the dashboard and kiosk mode with staff before launch

### For Kiosk Setup

- **Dedicated Device** - Use a tablet or Chromebook dedicated to the kiosk
- **Auto-Launch** - Set the browser to open the kiosk URL on startup
- **Lock Down** - Use guided access (iPad) or kiosk mode (Chrome) to prevent students from navigating away
- **Power** - Keep the device plugged in to avoid battery issues
- **Visibility** - Place where students can easily access it but teachers can see it

---

## Technical Specifications

### System Requirements

**Teacher Dashboard:**
- Modern web browser (Chrome, Firefox, Safari, Edge)
- Internet connection
- Display resolution: 1024x768 minimum

**Kiosk Devices:**
- Any device with a modern web browser
- Internet connection
- Touch screen recommended (not required)
- Badge scanner (optional, for Badge Kiosk mode)

**Server:**
- Node.js 20+
- PostgreSQL database
- HTTPS/TLS certificate

### API Endpoints

**Pass Management:**
- `GET /api/passes/active` - All active passes
- `GET /api/passes/history` - Historical pass data with filters
- `POST /api/passes` - Create a new pass
- `PUT /api/passes/:id/return` - Mark pass as returned
- `DELETE /api/passes/:id` - Cancel a pass

**Kiosk (Public):**
- `POST /api/kiosk/lookup` - Find student by ID number
- `POST /api/kiosk/checkout` - Issue pass from kiosk
- `POST /api/kiosk/checkin` - Return pass from kiosk
- `GET /api/kiosk/grades` - List classes for grade picker
- `GET /api/kiosk/students` - Students in grade with pass status

---

**Last Updated:** February 2026
**Version:** 1.0
**Copyright:** SchoolPilot Team

---

*This guide is provided for educational purposes. Schools are responsible for ensuring compliance with all applicable privacy laws and regulations.*
