// Tool definitions for SchoolPilot AI Assistant
// Each tool maps to existing storage functions

import type Anthropic from "@anthropic-ai/sdk";

export interface ChatTool {
  definition: Anthropic.Tool;
  product: "classpilot" | "gopilot" | "passpilot" | "shared";
  requiredRoles: string[];
  mutating: boolean;
}

const allStaffRoles = ["admin", "school_admin", "teacher", "office_staff"];
const adminOnly = ["admin", "school_admin"];
const teacherAndAdmin = ["admin", "school_admin", "teacher"];
const allRoles = [
  "admin",
  "school_admin",
  "teacher",
  "office_staff",
  "parent",
];

export const chatTools: ChatTool[] = [
  // === SHARED ===
  {
    definition: {
      name: "list_students",
      description:
        "List all students enrolled at the school. Returns student names, grade levels, and basic info.",
      input_schema: {
        type: "object" as const,
        properties: {},
        required: [],
      },
    },
    product: "shared",
    requiredRoles: allStaffRoles,
    mutating: false,
  },
  {
    definition: {
      name: "create_student",
      description:
        "Create a new student in the school. Requires first name, last name, and grade level.",
      input_schema: {
        type: "object" as const,
        properties: {
          firstName: {
            type: "string",
            description: "Student's first name",
          },
          lastName: {
            type: "string",
            description: "Student's last name",
          },
          gradeLevel: {
            type: "string",
            description: "Grade level (K, 1, 2, ..., 12)",
          },
          email: {
            type: "string",
            description: "Student's email address (optional)",
          },
        },
        required: ["firstName", "lastName", "gradeLevel"],
      },
    },
    product: "shared",
    requiredRoles: adminOnly,
    mutating: true,
  },
  {
    definition: {
      name: "mark_students_absent",
      description:
        "Mark one or more students as absent, tardy, or early dismissal for today.",
      input_schema: {
        type: "object" as const,
        properties: {
          studentIds: {
            type: "array",
            items: { type: "string" },
            description: "Array of student IDs to mark",
          },
          status: {
            type: "string",
            enum: ["absent", "tardy", "early_dismissal"],
            description: "Attendance status",
          },
          reason: {
            type: "string",
            enum: ["sick", "family", "appointment", "other"],
            description: "Reason for absence (optional)",
          },
        },
        required: ["studentIds", "status"],
      },
    },
    product: "shared",
    requiredRoles: allStaffRoles,
    mutating: true,
  },
  {
    definition: {
      name: "get_attendance_today",
      description:
        "Get today's attendance records — which students are marked absent, tardy, or early dismissal.",
      input_schema: {
        type: "object" as const,
        properties: {},
        required: [],
      },
    },
    product: "shared",
    requiredRoles: allStaffRoles,
    mutating: false,
  },

  // === CLASSPILOT ===
  {
    definition: {
      name: "list_classes",
      description:
        "List all classes (groups) at the school with their teacher, grade level, and student count.",
      input_schema: {
        type: "object" as const,
        properties: {},
        required: [],
      },
    },
    product: "classpilot",
    requiredRoles: teacherAndAdmin,
    mutating: false,
  },
  {
    definition: {
      name: "create_class",
      description:
        "Create a new class. Requires a name, grade level, and teacher assignment.",
      input_schema: {
        type: "object" as const,
        properties: {
          name: {
            type: "string",
            description:
              'Class name (e.g., "7th Grade Science", "ELA Period 3")',
          },
          gradeLevel: {
            type: "string",
            description: "Grade level (K, 1, 2, ..., 12)",
          },
          periodLabel: {
            type: "string",
            description:
              'Period label (e.g., "P1", "10:00-10:55") — optional',
          },
        },
        required: ["name", "gradeLevel"],
      },
    },
    product: "classpilot",
    requiredRoles: adminOnly,
    mutating: true,
  },
  {
    definition: {
      name: "list_flight_paths",
      description:
        "List all flight paths (website allowlists) at the school. Shows name, allowed domains, and whether it's a default.",
      input_schema: {
        type: "object" as const,
        properties: {},
        required: [],
      },
    },
    product: "classpilot",
    requiredRoles: teacherAndAdmin,
    mutating: false,
  },
  {
    definition: {
      name: "create_flight_path",
      description:
        "Create a new flight path (website allowlist). Students will only be able to visit the domains you specify when this flight path is applied.",
      input_schema: {
        type: "object" as const,
        properties: {
          name: {
            type: "string",
            description:
              'Name for the flight path (e.g., "Math Research", "ELA Lesson 1")',
          },
          allowedDomains: {
            type: "array",
            items: { type: "string" },
            description:
              'List of allowed website domains (e.g., ["khanacademy.org", "desmos.com"])',
          },
          description: {
            type: "string",
            description: "Optional description of what this flight path is for",
          },
        },
        required: ["name", "allowedDomains"],
      },
    },
    product: "classpilot",
    requiredRoles: teacherAndAdmin,
    mutating: true,
  },

  // === GOPILOT ===
  {
    definition: {
      name: "list_homerooms",
      description:
        "List all homerooms at the school with their teacher, grade, and room number.",
      input_schema: {
        type: "object" as const,
        properties: {},
        required: [],
      },
    },
    product: "gopilot",
    requiredRoles: allStaffRoles,
    mutating: false,
  },
  {
    definition: {
      name: "create_homeroom",
      description:
        "Create a new homeroom. Requires a name and grade level.",
      input_schema: {
        type: "object" as const,
        properties: {
          name: {
            type: "string",
            description: 'Homeroom name (e.g., "Mrs. Smith\'s Class")',
          },
          grade: {
            type: "string",
            description: "Grade level (K, 1, 2, ..., 12)",
          },
          room: {
            type: "string",
            description: "Room number (optional)",
          },
        },
        required: ["name", "grade"],
      },
    },
    product: "gopilot",
    requiredRoles: adminOnly,
    mutating: true,
  },
  {
    definition: {
      name: "get_dismissal_stats",
      description:
        "Get today's dismissal statistics — how many students are pending, called, dismissed, and held.",
      input_schema: {
        type: "object" as const,
        properties: {},
        required: [],
      },
    },
    product: "gopilot",
    requiredRoles: allStaffRoles,
    mutating: false,
  },

  // === PASSPILOT ===
  {
    definition: {
      name: "list_active_passes",
      description:
        "List all currently active hall passes at the school, showing student name, destination, and time elapsed.",
      input_schema: {
        type: "object" as const,
        properties: {},
        required: [],
      },
    },
    product: "passpilot",
    requiredRoles: teacherAndAdmin,
    mutating: false,
  },
  {
    definition: {
      name: "issue_pass",
      description:
        "Issue a hall pass to a student. Requires the student ID and destination.",
      input_schema: {
        type: "object" as const,
        properties: {
          studentId: {
            type: "string",
            description: "The student's ID",
          },
          destination: {
            type: "string",
            enum: [
              "bathroom",
              "nurse",
              "office",
              "counselor",
              "other_classroom",
            ],
            description: "Where the student is going",
          },
          duration: {
            type: "number",
            description: "Duration in minutes (default: 5)",
          },
        },
        required: ["studentId", "destination"],
      },
    },
    product: "passpilot",
    requiredRoles: teacherAndAdmin,
    mutating: true,
  },

  // === ESCALATION ===
  {
    definition: {
      name: "report_system_issue",
      description:
        "Report a suspected system bug or issue to the development team. Use this when you've determined the user's problem is caused by a system malfunction rather than user error — for example, a feature that should work but doesn't, data that appears missing or corrupted, or an action that consistently fails after troubleshooting.",
      input_schema: {
        type: "object" as const,
        properties: {
          summary: {
            type: "string",
            description: "Brief description of the issue",
          },
          category: {
            type: "string",
            enum: ["bug", "data_issue", "feature_broken", "performance"],
            description: "Category of the issue",
          },
          severity: {
            type: "string",
            enum: ["low", "medium", "high"],
            description:
              "Severity — high if blocking user workflow, medium if workaround exists, low if cosmetic",
          },
          steps_attempted: {
            type: "string",
            description:
              "What troubleshooting steps were attempted before escalating",
          },
        },
        required: ["summary", "category", "severity", "steps_attempted"],
      },
    },
    product: "shared",
    requiredRoles: allRoles,
    mutating: false,
  },
];

/**
 * Get tools available for a given role and set of licensed products.
 * Returns Anthropic tool definitions ready to pass to the API.
 */
export function getToolsForContext(
  role: string,
  licensedProducts: string[]
): { tools: Anthropic.Tool[]; toolMeta: Map<string, ChatTool> } {
  const lp = new Set(licensedProducts.map((p) => p.toUpperCase()));

  const filtered = chatTools.filter((t) => {
    // Check role permission
    if (!t.requiredRoles.includes(role)) return false;

    // Check product license (shared tools always available)
    if (t.product === "shared") return true;
    if (t.product === "classpilot" && !lp.has("CLASSPILOT")) return false;
    if (t.product === "gopilot" && !lp.has("GOPILOT")) return false;
    if (t.product === "passpilot" && !lp.has("PASSPILOT")) return false;

    return true;
  });

  const toolMeta = new Map<string, ChatTool>();
  const tools: Anthropic.Tool[] = [];

  for (const t of filtered) {
    tools.push(t.definition);
    toolMeta.set(t.definition.name, t);
  }

  return { tools, toolMeta };
}
