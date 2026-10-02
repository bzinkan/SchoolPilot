import { useState, useEffect, useLayoutEffect, useRef } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { Button } from "../../../components/ui/button";
import { Input } from "../../../components/ui/input";
import { Label } from "../../../components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../../components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../../components/ui/select";
import { Textarea } from "../../../components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../../../components/ui/dialog";
import { Badge } from "../../../components/ui/badge";
import { useToast } from "../../../hooks/use-toast";
import { apiRequest, queryClient } from "../../../lib/queryClient";
import { ArrowLeft, User, Users, Save, Plus, Edit, Trash2, Plane, AlertCircle, ShieldBan, UsersRound, UserPlus, UserMinus, Library, Share2, Copy, ShieldCheck } from "lucide-react";
import { ThemeToggle } from "../../../components/ThemeToggle";
import { TeacherSettingsTabs } from "../components/ScheduleRouteTabs";
import { useClassPilotAuth } from "../../../hooks/useClassPilotAuth";
import { useAdminNavigation, useAdminNavigationBlocker } from "../hooks/useAdminNavigation";
import { teachingToolsSection, teachingToolsShouldBlock } from "../lib/teachingTools";
import TeachingDefaults from "../components/TeachingDefaults";
import ClassroomWebsiteImport from "../components/ClassroomWebsiteImport";
import { teachingResourceBadge, teachingResourceErrorMessage, teachingResourceList } from "../lib/teachingResourceLibrary";
import { restrictionResourceLabel, restrictionResourceUrl } from "../lib/restrictionResourceMatcher";
import { useRestrictionScopePreview } from "../hooks/useRestrictionScopePreview";
import RestrictionScopeReview from "../components/RestrictionScopeReview";

const EMPTY_RESOURCE_LIST = Object.freeze({ own: Object.freeze([]), library: Object.freeze([]), libraryEnabled: false });
const selectFlightPathList = (data) => teachingResourceList(data, 'flightPaths');
// Precise Flight Path entries (videos, documents, forms, pages) are editable
// only while the server reports preciseRestrictionResourcesV1 active for the
// school; the School Library is not a prerequisite.
const selectPreciseResourcesEnabled = (data) => data?.features?.preciseRestrictionResources === true;
const resourceLinesOf = (flightPath) => (flightPath?.resources || []).map(restrictionResourceUrl).filter(Boolean).join("\n");
const selectBlockListList = (data) => teachingResourceList(data, 'blockLists');

// Shared / Official marker; the id keeps own rows and School Library rows distinct.
function ResourceBadge({ item }) {
  const badge = teachingResourceBadge(item);
  if (!badge) return null;
  return (
    <Badge variant={badge === 'Official' ? 'default' : 'secondary'} className="text-xs" data-testid={`badge-${badge.toLowerCase()}-${item.id}`}>
      {badge}
    </Badge>
  );
}

export default function MySettings() {
  const { currentUser, isLoading, logout } = useClassPilotAuth();
  if (isLoading) return <p role="status" className="p-6">Loading Teaching tools…</p>;
  if (!currentUser?.schoolId || !currentUser?.roles?.some(role => ['teacher', 'admin', 'school_admin'].includes(role))) return <p className="p-6">Sign in with an active school teaching account to use Teaching tools.</p>;
  return <TeachingToolsContent key={`${currentUser.schoolId}:${currentUser.id}:${currentUser.roles.join(',')}`} currentUser={currentUser} logout={logout} />;
}

function TeachingToolsContent({ currentUser, logout }) {
  const { navigate, requestAction } = useAdminNavigation();
  const location = useLocation();
  const routeNavigate = useNavigate();
  const section = teachingToolsSection(location.search);
  const { toast } = useToast();
  const scope = [currentUser.schoolId, currentUser.id];
  const lifetime = useRef({ alive: true, controller: new AbortController() });
  useEffect(() => { const state = lifetime.current; state.alive = true; if (state.controller.signal.aborted) state.controller = new AbortController(); return () => { state.alive = false; state.controller.abort(); }; }, []);
  const request = (method, path, data, options = {}) => apiRequest(method, path, data, {
    ...options, signal: options.signal || lifetime.current.controller.signal,
    headers: { ...options.headers, 'X-School-Id': currentUser.schoolId },
  });
  const closeEditor = action => { void requestAction(action, { id: 'teaching-close:editor' }); };

  const [showFlightPathDialog, setShowFlightPathDialog] = useState(false);
  const [editingFlightPath, setEditingFlightPath] = useState(null);
  const [flightPathName, setFlightPathName] = useState("");
  const [flightPathDescription, setFlightPathDescription] = useState("");
  const [flightPathAllowedDomains, setFlightPathAllowedDomains] = useState("");
  const [flightPathResources, setFlightPathResources] = useState("");
  const [deleteFlightPathId, setDeleteFlightPathId] = useState(null);

  // Block Lists state
  const [showBlockListDialog, setShowBlockListDialog] = useState(false);
  const [editingBlockList, setEditingBlockList] = useState(null);
  const [blockListName, setBlockListName] = useState("");
  const [blockListDescription, setBlockListDescription] = useState("");
  const [blockListDomains, setBlockListDomains] = useState("");
  const [deleteBlockListId, setDeleteBlockListId] = useState(null);

  // Subgroups state
  const requestedGroupId = new URLSearchParams(location.search).get("classId") || new URLSearchParams(location.search).get("groupId") || "";
  const classEpoch = useRef(0);
  const [showSubgroupDialog, setShowSubgroupDialog] = useState(false);
  const [editingSubgroup, setEditingSubgroup] = useState(null);
  const [subgroupName, setSubgroupName] = useState("");
  const [subgroupColor, setSubgroupColor] = useState("#9333ea");
  const [deleteSubgroupId, setDeleteSubgroupId] = useState(null);
  const [showManageMembersDialog, setShowManageMembersDialog] = useState(false);
  const [managingSubgroup, setManagingSubgroup] = useState(null);

  // Co-teachers state
  const [coTeacherToAdd, setCoTeacherToAdd] = useState("");

  const { data: flightPathData = EMPTY_RESOURCE_LIST, isError: flightPathsError, refetch: retryFlightPaths } = useQuery({
    queryKey: ['/api/flight-paths', ...scope],
    queryFn: ({ signal }) => request('GET', '/flight-paths', undefined, { signal }),
    select: selectFlightPathList,
  });
  const flightPaths = flightPathData.own;
  const { data: preciseResourcesEnabled = false } = useQuery({
    queryKey: ['/api/flight-paths', ...scope],
    queryFn: ({ signal }) => request('GET', '/flight-paths', undefined, { signal }),
    select: selectPreciseResourcesEnabled,
  });
  // One link per line. Sent only while the feature is on, so an owner can
  // always edit the websites of a path whose resources are switched off.
  const resourcesPayload = () => (preciseResourcesEnabled
    ? {
        resources: flightPathResources.split("\n").map((line) => line.trim()).filter(Boolean).map((url) => ({ url })),
      }
    : {});
  const flightPathPreview = useRestrictionScopePreview({ schoolId: currentUser.schoolId, viewerId: currentUser.id,
    enabled: showFlightPathDialog,
    input: { purpose: 'flight_path', allowedDomains: flightPathAllowedDomains.split(',').map(line => line.trim()).filter(Boolean), resources: resourcesPayload().resources || [] },
    context: [editingFlightPath?.id, flightPathName, flightPathDescription, preciseResourcesEnabled],
  });
  const flightPathReviewRequired = preciseResourcesEnabled && Boolean(flightPathResources.trim());
  const flightPathScopePayload = () => flightPathPreview.preview
    ? { allowedDomains: flightPathPreview.preview.authoring.allowedDomains, ...(preciseResourcesEnabled ? { resources: flightPathPreview.preview.authoring.resources } : {}) }
    : { allowedDomains: flightPathAllowedDomains.split(',').map(d => normalizeDomain(d)).filter(Boolean), ...resourcesPayload() };

  const { data: blockListData = EMPTY_RESOURCE_LIST, isError: blockListsError, refetch: retryBlockLists } = useQuery({
    queryKey: ['/api/block-lists', ...scope],
    queryFn: ({ signal }) => request('GET', '/block-lists', undefined, { signal }),
    select: selectBlockListList,
  });
  const blockLists = blockListData.own;
  // The School Library card and share/official actions exist only while the
  // server reports the library as on for this school.
  const schoolLibraryEnabled = flightPathData.libraryEnabled || blockListData.libraryEnabled;

  const { data: groups = [] } = useQuery({
    queryKey: ['/api/teacher/groups', ...scope],
    queryFn: ({ signal }) => request('GET', '/teacher/groups', undefined, { signal }),
    select: (data) => Array.isArray(data) ? data : data?.groups ?? [],
  });

  const selectedGroupId = groups.some(group => group.id === requestedGroupId) ? requestedGroupId : '';
  const [classDraftScope, setClassDraftScope] = useState(selectedGroupId);
  if (classDraftScope !== selectedGroupId) {
    setClassDraftScope(selectedGroupId);
    setShowSubgroupDialog(false); setEditingSubgroup(null); setSubgroupName(''); setSubgroupColor('#9333ea');
    setDeleteSubgroupId(null); setShowManageMembersDialog(false); setManagingSubgroup(null); setCoTeacherToAdd('');
  }
  useLayoutEffect(() => {
    classEpoch.current += 1;
    return () => {
      classEpoch.current += 1;
      const predicate = query => query.queryKey.at(-2) === currentUser.schoolId && query.queryKey.at(-1) === currentUser.id
        && ((query.queryKey[0] === '/api/groups' && query.queryKey[1] === selectedGroupId) || query.queryKey[0] === '/api/subgroups');
      void queryClient.cancelQueries({ predicate });
      queryClient.removeQueries({ predicate });
    };
  }, [selectedGroupId, currentUser.schoolId, currentUser.id]);
  const selectGroup = value => {
    if (!groups.some(group => group.id === value)) return;
    void requestAction(() => {
      const params = new URLSearchParams(location.search); params.set('classId', value); params.delete('groupId');
      routeNavigate({ pathname: location.pathname, search: `?${params}`, hash: location.hash }, { state: location.state });
    }, { id: 'teaching-class-switch' });
  };

  const { data: subgroups = [], refetch: refetchSubgroups } = useQuery({
    queryKey: ['/api/groups', selectedGroupId, 'subgroups', ...scope],
    queryFn: async ({ signal }) => {
      if (!selectedGroupId) return [];
      const data = await request('GET', `/groups/${selectedGroupId}/subgroups`, undefined, { signal });
      return data.subgroups || [];
    },
    enabled: !!selectedGroupId,
  });

  const { data: groupStudents = [] } = useQuery({
    queryKey: ['/api/groups', selectedGroupId, 'students', ...scope],
    queryFn: async ({ signal }) => {
      if (!selectedGroupId) return [];
      const data = await request('GET', `/groups/${selectedGroupId}/students`, undefined, { signal });
      return Array.isArray(data) ? data : [];
    },
    enabled: !!selectedGroupId,
  });

  const { data: subgroupMembers = [], refetch: refetchMembers } = useQuery({
    queryKey: ['/api/subgroups', managingSubgroup?.id, 'members', ...scope],
    queryFn: async ({ signal }) => (await request('GET', `/subgroups/${managingSubgroup.id}/members`, undefined, { signal })).members || [],
    enabled: Boolean(selectedGroupId) && showManageMembersDialog && Boolean(managingSubgroup?.id),
  });

  // Only classes this teacher owns can have their co-teachers managed here.
  // Official classes (admin_class) are managed by administrators.
  const ownedGroups = groups.filter(
    (group) => group.groupType !== "admin_class" && group.teacherId === currentUser?.id
  );

  const { data: groupTeachers = [] } = useQuery({
    queryKey: ['/api/groups', selectedGroupId, 'teachers', ...scope],
    queryFn: async ({ signal }) => {
      if (!selectedGroupId) return [];
      const data = await request('GET', `/groups/${selectedGroupId}/teachers`, undefined, { signal });
      return Array.isArray(data?.teachers) ? data.teachers : [];
    },
    enabled: !!selectedGroupId,
  });

  // ?teachable=true also returns admins / school admins who may teach a class
  // (the school owner is often an admin who also teaches).
  const { data: schoolTeachers = [] } = useQuery({
    queryKey: ['/api/users/teachers', 'teachable', ...scope],
    queryFn: async ({ signal }) => {
      const data = await request('GET', '/users/teachers?teachable=true', undefined, { signal });
      return Array.isArray(data?.teachers) ? data.teachers : [];
    },
    enabled: !!selectedGroupId,
  });

  const canManageCoTeachers = ownedGroups.some(group => group.id === selectedGroupId);

  const assignedTeacherIds = new Set(groupTeachers.map((entry) => entry.teacherId));
  const availableCoTeachers = schoolTeachers.filter(
    (teacher) => teacher.userId !== currentUser?.id && !assignedTeacherIds.has(teacher.userId)
  );

  const teacherDisplayName = (teacher) => {
    const name =
      [teacher.user?.firstName, teacher.user?.lastName].filter(Boolean).join(" ") ||
      teacher.user?.email ||
      teacher.userId;
    const isAdmin = teacher.role === "admin" || teacher.role === "school_admin";
    return isAdmin ? `${name} (admin)` : name;
  };

  const normalizeDomain = (domain) => {
    return domain.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/$/, '');
  };

  const resetFlightPathForm = () => {
    setFlightPathName("");
    setFlightPathDescription("");
    setFlightPathAllowedDomains("");
    setFlightPathResources("");
    setEditingFlightPath(null);
  };

  const createFlightPathMutation = useMutation({
    mutationFn: async () => {
      return await request("POST", "/flight-paths", {
        flightPathName,
        description: flightPathDescription || undefined,
        ...flightPathScopePayload(),
      });
    },
    onSuccess: () => {
      if (!lifetime.current.alive) return;
      queryClient.invalidateQueries({ queryKey: ['/api/flight-paths'] });
      toast({ title: "Flight Path created", description: `"${flightPathName}" has been created successfully` });
      setShowFlightPathDialog(false);
      resetFlightPathForm();
    },
    onError: (error) => {
      if (!lifetime.current.alive) return;
      toast({ variant: "destructive", title: "Failed to create Flight Path", description: teachingResourceErrorMessage(error) });
    },
  });

  const updateFlightPathMutation = useMutation({
    mutationFn: async () => {
      if (!editingFlightPath) throw new Error("No Flight Path to update");
      return await request("PATCH", `/flight-paths/${editingFlightPath.id}`, {
        flightPathName,
        description: flightPathDescription || undefined,
        ...flightPathScopePayload(),
      });
    },
    onSuccess: () => {
      if (!lifetime.current.alive) return;
      queryClient.invalidateQueries({ queryKey: ['/api/flight-paths'] });
      toast({ title: "Flight Path updated", description: `"${flightPathName}" has been updated successfully` });
      setShowFlightPathDialog(false);
      resetFlightPathForm();
    },
    onError: (error) => {
      if (!lifetime.current.alive) return;
      toast({ variant: "destructive", title: "Failed to update Flight Path", description: teachingResourceErrorMessage(error) });
    },
  });

  const deleteFlightPathMutation = useMutation({
    mutationFn: async (id) => {
      return await request("DELETE", `/flight-paths/${id}`, {});
    },
    onSuccess: () => {
      if (!lifetime.current.alive) return;
      queryClient.invalidateQueries({ queryKey: ['/api/flight-paths'] });
      toast({ title: "Flight Path deleted", description: "Flight Path has been deleted successfully" });
      setDeleteFlightPathId(null);
    },
    onError: (error) => {
      if (!lifetime.current.alive) return;
      toast({ variant: "destructive", title: "Failed to delete Flight Path", description: error.message });
    },
  });

  // Block List mutations
  const resetBlockListForm = () => {
    setBlockListName("");
    setBlockListDescription("");
    setBlockListDomains("");
    setEditingBlockList(null);
  };

  const createBlockListMutation = useMutation({
    mutationFn: async () => {
      return await request("POST", "/block-lists", {
        name: blockListName,
        description: blockListDescription || undefined,
        blockedDomains: blockListDomains.split(",").map(d => normalizeDomain(d)).filter(Boolean),
      });
    },
    onSuccess: () => {
      if (!lifetime.current.alive) return;
      queryClient.invalidateQueries({ queryKey: ['/api/block-lists'] });
      toast({ title: "Block List created", description: `"${blockListName}" has been created successfully` });
      setShowBlockListDialog(false);
      resetBlockListForm();
    },
    onError: (error) => {
      if (!lifetime.current.alive) return;
      toast({ variant: "destructive", title: "Failed to create Block List", description: error.message });
    },
  });

  const updateBlockListMutation = useMutation({
    mutationFn: async () => {
      if (!editingBlockList) throw new Error("No Block List to update");
      return await request("PATCH", `/block-lists/${editingBlockList.id}`, {
        name: blockListName,
        description: blockListDescription || undefined,
        blockedDomains: blockListDomains.split(",").map(d => normalizeDomain(d)).filter(Boolean),
      });
    },
    onSuccess: () => {
      if (!lifetime.current.alive) return;
      queryClient.invalidateQueries({ queryKey: ['/api/block-lists'] });
      toast({ title: "Block List updated", description: `"${blockListName}" has been updated successfully` });
      setShowBlockListDialog(false);
      resetBlockListForm();
    },
    onError: (error) => {
      if (!lifetime.current.alive) return;
      toast({ variant: "destructive", title: "Failed to update Block List", description: error.message });
    },
  });

  const deleteBlockListMutation = useMutation({
    mutationFn: async (id) => {
      return await request("DELETE", `/block-lists/${id}`, {});
    },
    onSuccess: () => {
      if (!lifetime.current.alive) return;
      queryClient.invalidateQueries({ queryKey: ['/api/block-lists'] });
      toast({ title: "Block List deleted", description: "Block List has been deleted successfully" });
      setDeleteBlockListId(null);
    },
    onError: (error) => {
      if (!lifetime.current.alive) return;
      toast({ variant: "destructive", title: "Failed to delete Block List", description: error.message });
    },
  });

  // School Library actions. The server authorizes each one (owner-only sharing,
  // administrator-only official marking, copy for anyone who can see the item)
  // and audits it; the buttons below only appear when the list says they apply.
  const libraryActionMutation = useMutation({
    mutationFn: async ({ resource, id, action, body }) => request("POST", `/${resource}/${id}/${action}`, body),
    onSuccess: (_data, variables) => {
      if (!lifetime.current.alive) return;
      queryClient.invalidateQueries({ queryKey: [variables.resource === "flight-paths" ? '/api/flight-paths' : '/api/block-lists'] });
      toast({ title: variables.successTitle, description: variables.successDescription });
    },
    onError: (error, variables) => {
      if (!lifetime.current.alive) return;
      toast({ variant: "destructive", title: variables.failureTitle, description: teachingResourceErrorMessage(error) });
    },
  });

  const shareResource = (resource, item, label) => {
    const sharing = item.visibility !== "school";
    libraryActionMutation.mutate({
      resource, id: item.id, action: "visibility", body: { visibility: sharing ? "school" : "private" },
      successTitle: sharing ? `${label} shared` : `${label} unshared`,
      successDescription: sharing
        ? "Teachers in your school can now apply or copy it from the School Library."
        : "It is private to you again. Copies other teachers already made are theirs.",
      failureTitle: `Could not change how this ${label} is shared`,
    });
  };

  const markResourceOfficial = (resource, item, label) => {
    const official = item.official !== true;
    libraryActionMutation.mutate({
      resource, id: item.id, action: "official", body: { official },
      successTitle: official ? `${label} marked official` : `Official mark removed`,
      successDescription: official
        ? "Teachers can apply or copy it; only administrators can change it."
        : "It keeps its current sharing setting.",
      failureTitle: `Could not change the official mark`,
    });
  };

  const copyResource = (resource, item, label, name) => {
    libraryActionMutation.mutate({
      resource, id: item.id, action: "copy", body: {},
      successTitle: `${label} copied`,
      successDescription: `"${name}" is now in your own ${label}s as a private copy you can edit.`,
      failureTitle: `Could not copy this ${label}`,
    });
  };

  const handleEditBlockList = (blockList) => {
    setEditingBlockList(blockList);
    setBlockListName(blockList.name);
    setBlockListDescription(blockList.description || "");
    setBlockListDomains(blockList.blockedDomains?.join(", ") || "");
    setShowBlockListDialog(true);
  };

  const handleSaveBlockList = () => {
    if (editingBlockList) {
      updateBlockListMutation.mutate();
    } else {
      createBlockListMutation.mutate();
    }
  };

  // Subgroup mutations
  const createSubgroupMutation = useMutation({
    onMutate: () => ({ epoch: classEpoch.current }),
    mutationFn: async () => {
      return await request("POST", `/groups/${selectedGroupId}/subgroups`, {
        name: subgroupName,
        color: subgroupColor,
      });
    },
    onSuccess: (_data, _variables, context) => {
      if (!lifetime.current.alive || context?.epoch !== classEpoch.current) return;
      refetchSubgroups();
      toast({ title: "Subgroup created", description: `${subgroupName} has been created successfully` });
      resetSubgroupForm();
      setShowSubgroupDialog(false);
    },
    onError: (error, _variables, context) => {
      if (!lifetime.current.alive || context?.epoch !== classEpoch.current) return;
      toast({ variant: "destructive", title: "Failed to create subgroup", description: error.message });
    },
  });

  const updateSubgroupMutation = useMutation({
    onMutate: () => ({ epoch: classEpoch.current }),
    mutationFn: async () => {
      if (!editingSubgroup) return;
      return await request("PUT", `/subgroups/${editingSubgroup.id}`, {
        name: subgroupName,
        color: subgroupColor,
      });
    },
    onSuccess: (_data, _variables, context) => {
      if (!lifetime.current.alive || context?.epoch !== classEpoch.current) return;
      refetchSubgroups();
      toast({ title: "Subgroup updated", description: `${subgroupName} has been updated successfully` });
      resetSubgroupForm();
      setShowSubgroupDialog(false);
    },
    onError: (error, _variables, context) => {
      if (!lifetime.current.alive || context?.epoch !== classEpoch.current) return;
      toast({ variant: "destructive", title: "Failed to update subgroup", description: error.message });
    },
  });

  const deleteSubgroupMutation = useMutation({
    onMutate: () => ({ epoch: classEpoch.current }),
    mutationFn: async (id) => {
      return await request("DELETE", `/subgroups/${id}`, {});
    },
    onSuccess: (_data, _variables, context) => {
      if (!lifetime.current.alive || context?.epoch !== classEpoch.current) return;
      refetchSubgroups();
      toast({ title: "Subgroup deleted", description: "Subgroup has been deleted successfully" });
      setDeleteSubgroupId(null);
    },
    onError: (error, _variables, context) => {
      if (!lifetime.current.alive || context?.epoch !== classEpoch.current) return;
      toast({ variant: "destructive", title: "Failed to delete subgroup", description: error.message });
    },
  });

  const addSubgroupMemberMutation = useMutation({
    onMutate: () => ({ epoch: classEpoch.current }),
    mutationFn: async ({ subgroupId, studentId }) => {
      return await request("POST", `/subgroups/${subgroupId}/members`, { studentIds: [studentId] });
    },
    onSuccess: (_data, _variables, context) => {
      if (!lifetime.current.alive || context?.epoch !== classEpoch.current) return;
      if (managingSubgroup) {
        refetchMembers();
      }
      toast({ title: "Student added", description: "Student has been added to the subgroup" });
    },
    onError: (error, _variables, context) => {
      if (!lifetime.current.alive || context?.epoch !== classEpoch.current) return;
      toast({ variant: "destructive", title: "Failed to add student", description: error.message });
    },
  });

  const removeSubgroupMemberMutation = useMutation({
    onMutate: () => ({ epoch: classEpoch.current }),
    mutationFn: async ({ subgroupId, studentId }) => {
      return await request("DELETE", `/subgroups/${subgroupId}/members/${studentId}`, {});
    },
    onSuccess: (_data, _variables, context) => {
      if (!lifetime.current.alive || context?.epoch !== classEpoch.current) return;
      if (managingSubgroup) {
        refetchMembers();
      }
      toast({ title: "Student removed", description: "Student has been removed from the subgroup" });
    },
    onError: (error, _variables, context) => {
      if (!lifetime.current.alive || context?.epoch !== classEpoch.current) return;
      toast({ variant: "destructive", title: "Failed to remove student", description: error.message });
    },
  });

  const resetSubgroupForm = () => {
    setSubgroupName("");
    setSubgroupColor("#9333ea");
    setEditingSubgroup(null);
  };

  const handleEditSubgroup = (subgroup) => {
    setEditingSubgroup(subgroup);
    setSubgroupName(subgroup.name);
    setSubgroupColor(subgroup.color || "#9333ea");
    setShowSubgroupDialog(true);
  };

  const handleSaveSubgroup = () => {
    if (editingSubgroup) {
      updateSubgroupMutation.mutate();
    } else {
      createSubgroupMutation.mutate();
    }
  };

  const handleManageMembers = (subgroup) => {
    setManagingSubgroup(subgroup);
    setShowManageMembersDialog(true);
  };

  // Co-teacher mutations
  const invalidateGroupTeachers = () => {
    queryClient.invalidateQueries({ queryKey: ['/api/groups', selectedGroupId, 'teachers', ...scope] });
  };

  const addCoTeacherMutation = useMutation({
    onMutate: () => ({ epoch: classEpoch.current }),
    mutationFn: async (teacherId) => {
      return await request("POST", `/groups/${selectedGroupId}/teachers`, { teacherId });
    },
    onSuccess: (_data, _variables, context) => {
      if (!lifetime.current.alive || context?.epoch !== classEpoch.current) return;
      invalidateGroupTeachers();
      setCoTeacherToAdd("");
      toast({ title: "Co-teacher added", description: "They can now start and manage this class." });
    },
    onError: (error, _variables, context) => {
      if (!lifetime.current.alive || context?.epoch !== classEpoch.current) return;
      toast({
        variant: "destructive",
        title: "Failed to add co-teacher",
        description: error.response?.data?.error || error.message,
      });
    },
  });

  const removeCoTeacherMutation = useMutation({
    onMutate: () => ({ epoch: classEpoch.current }),
    mutationFn: async (teacherId) => {
      return await request("DELETE", `/groups/${selectedGroupId}/teachers/${teacherId}`, {});
    },
    onSuccess: (_data, _variables, context) => {
      if (!lifetime.current.alive || context?.epoch !== classEpoch.current) return;
      invalidateGroupTeachers();
      toast({ title: "Co-teacher removed", description: "They can no longer start or manage this class." });
    },
    onError: (error, _variables, context) => {
      if (!lifetime.current.alive || context?.epoch !== classEpoch.current) return;
      toast({
        variant: "destructive",
        title: "Failed to remove co-teacher",
        description: error.response?.data?.error || error.message,
      });
    },
  });

  const handleEditFlightPath = (flightPath) => {
    setEditingFlightPath(flightPath);
    setFlightPathName(flightPath.flightPathName);
    setFlightPathDescription(flightPath.description || "");
    setFlightPathAllowedDomains(flightPath.allowedDomains?.join(", ") || "");
    setFlightPathResources(resourceLinesOf(flightPath));
    setShowFlightPathDialog(true);
  };

  const handleSaveFlightPath = () => {
    if (flightPathPreview.pending || (flightPathReviewRequired && !flightPathPreview.preview)) return;
    if (editingFlightPath) {
      updateFlightPathMutation.mutate();
    } else {
      createFlightPathMutation.mutate();
    }
  };

  const toolDirty = (showFlightPathDialog && JSON.stringify([flightPathName, flightPathDescription, flightPathAllowedDomains, flightPathResources]) !== JSON.stringify([editingFlightPath?.flightPathName || '', editingFlightPath?.description || '', editingFlightPath?.allowedDomains?.join(', ') || '', resourceLinesOf(editingFlightPath)]))
    || (showBlockListDialog && JSON.stringify([blockListName, blockListDescription, blockListDomains]) !== JSON.stringify([editingBlockList?.name || '', editingBlockList?.description || '', editingBlockList?.blockedDomains?.join(', ') || '']))
    || (showSubgroupDialog && JSON.stringify([subgroupName, subgroupColor]) !== JSON.stringify([editingSubgroup?.name || '', editingSubgroup?.color || '#9333ea']))
    || Boolean(coTeacherToAdd);
  const toolBusy = [createFlightPathMutation, updateFlightPathMutation, deleteFlightPathMutation, createBlockListMutation, updateBlockListMutation, deleteBlockListMutation, libraryActionMutation,
    createSubgroupMutation, updateSubgroupMutation, deleteSubgroupMutation, addSubgroupMemberMutation, removeSubgroupMemberMutation, addCoTeacherMutation, removeCoTeacherMutation].some(item => item.isPending);
  useAdminNavigationBlocker({ id: 'teaching-tool-editors', dirty: toolDirty, busy: toolBusy,
    shouldBlock: transition => ['teaching-close:editor', 'teaching-class-switch'].includes(transition.actionId) || teachingToolsShouldBlock(transition),
    onDiscard: () => { resetFlightPathForm(); resetBlockListForm(); resetSubgroupForm(); setCoTeacherToAdd(''); setShowFlightPathDialog(false); setShowBlockListDialog(false); setShowSubgroupDialog(false); setShowManageMembersDialog(false); } });

  return (
    <div className="min-h-screen bg-background">
      <div className="border-b bg-card">
        <div className="max-w-5xl mx-auto px-6 py-4">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="flex w-full flex-col gap-3 sm:w-auto">
              <Button
                data-testid="button-back"
                variant="ghost"
                className="w-fit px-0"
                onClick={() => navigate("/classpilot")}
              >
                <ArrowLeft className="mr-2 h-4 w-4" />Back to ClassPilot
              </Button>
              <div className="flex items-center gap-3">
                <div className="p-2 bg-primary/10 rounded-lg">
                  <User className="h-6 w-6 text-primary" />
                </div>
                <div>
                  <h1 className="text-2xl font-bold">Teaching tools</h1>
                  <p className="text-sm text-muted-foreground">Your websites, classes and personal defaults</p>
                </div>
              </div>
            </div>
            <div className="flex items-center gap-2"><ThemeToggle /><Button variant="ghost" onClick={() => { void requestAction(logout, { id: "logout" }); }}>Sign out</Button></div>
          </div>
        </div>
      </div>

      <div className="border-b bg-card">
        <div className="max-w-5xl mx-auto px-6 pt-3">
          <TeacherSettingsTabs />
          <div className="flex flex-wrap items-center justify-between gap-3 py-3 text-sm">
            <Link className="text-primary underline-offset-4 hover:underline" to="/classpilot/my-settings/schedule-changes">Schedule changes</Link>
            <span className="text-muted-foreground">Help: <Link className="text-primary underline-offset-4 hover:underline" to="/classpilot/my-settings/guide">Teacher guide</Link></span>
          </div>
        </div>
      </div>

      <div className="max-w-5xl mx-auto px-6 py-8">
        <div className="space-y-6">
          <section hidden={section !== "websites"} className="space-y-6" aria-label="Website tools">
            <h2 className="text-xl font-semibold">Website tools</h2>
            <ClassroomWebsiteImport schoolId={currentUser.schoolId} viewerId={currentUser.id} preciseResourcesEnabled={preciseResourcesEnabled} />
            {/* Flight Paths Section */}
            <Card data-testid="card-flight-paths">
              <CardHeader>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex items-center gap-2">
                    <Plane className="h-5 w-5 text-primary" />
                    <CardTitle>My Flight Paths</CardTitle>
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    onClick={() => {
                      resetFlightPathForm();
                      setShowFlightPathDialog(true);
                    }}
                    data-testid="button-create-flight-path"
                  >
                    <Plus className="h-4 w-4 mr-2" />
                    Create Flight Path
                  </Button>
                </div>
                <CardDescription>
                  Create and manage domain restriction sets for focused learning. Flight Paths limit student browsing to specific educational websites.
                </CardDescription>
              </CardHeader>
              <CardContent>
                {flightPathsError ? <p role="alert">Flight Paths could not be loaded. <Button variant="link" onClick={() => retryFlightPaths()}>Retry</Button></p> : flightPaths.length === 0 ? (
                  <div className="text-center py-8 text-muted-foreground">
                    <Plane className="h-12 w-12 mx-auto mb-3 opacity-20" />
                    <p>No Flight Paths created yet</p>
                    <p className="text-sm mt-1">Create your first Flight Path to get started</p>
                  </div>
                ) : (
                  <div className="space-y-3">
                    {flightPaths.map((fp) => (
                      <div
                        key={fp.id}
                        className="flex items-center justify-between p-4 rounded-lg border bg-card hover-elevate"
                        data-testid={`flight-path-${fp.id}`}
                      >
                        <div className="flex-1 min-w-0">
                          <div className="flex flex-wrap items-center gap-2 mb-1">
                            <h3 className="font-semibold">{fp.flightPathName}</h3>
                            {schoolLibraryEnabled && <ResourceBadge item={fp} />}
                          </div>
                          {fp.description && (
                            <p className="text-sm text-muted-foreground mb-2">{fp.description}</p>
                          )}
                          <div className="flex flex-wrap gap-1">
                            {fp.allowedDomains && fp.allowedDomains.length > 0 ? (
                              fp.allowedDomains.map((domain, idx) => (
                                <Badge key={idx} variant="outline" className="text-xs">
                                  {domain}
                                </Badge>
                              ))
                            ) : fp.resources?.length > 0 ? null : (
                              <span className="text-xs text-muted-foreground">No domains configured</span>
                            )}
                            {(fp.resources || []).map((entry, index) => (
                              <Badge key={`resource-${index}`} variant="secondary" className="text-xs" data-testid={`flight-path-resource-${fp.id}-${index}`}>
                                {restrictionResourceLabel(entry)}
                              </Badge>
                            ))}
                          </div>
                        </div>
                        <div className="flex flex-wrap items-center justify-end gap-2 ml-4">
                          {schoolLibraryEnabled && fp.canShare && (
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              disabled={libraryActionMutation.isPending}
                              onClick={() => shareResource("flight-paths", fp, "Flight Path")}
                              data-testid={`button-share-flight-path-${fp.id}`}
                            >
                              <Share2 className="h-4 w-4 mr-1" />
                              {fp.visibility === "school" ? "Stop sharing" : "Share with school"}
                            </Button>
                          )}
                          {schoolLibraryEnabled && fp.canMarkOfficial && (
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              disabled={libraryActionMutation.isPending}
                              onClick={() => markResourceOfficial("flight-paths", fp, "Flight Path")}
                              data-testid={`button-official-flight-path-${fp.id}`}
                            >
                              <ShieldCheck className="h-4 w-4 mr-1" />
                              {fp.official ? "Remove official" : "Mark official"}
                            </Button>
                          )}
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            disabled={fp.canEdit === false}
                            title={fp.canEdit === false ? "Official Flight Paths are managed by administrators" : undefined}
                            onClick={() => handleEditFlightPath(fp)}
                            data-testid={`button-edit-flight-path-${fp.id}`}
                          >
                            <Edit className="h-4 w-4" />
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            disabled={fp.canEdit === false}
                            title={fp.canEdit === false ? "Official Flight Paths are managed by administrators" : undefined}
                            onClick={() => setDeleteFlightPathId(fp.id)}
                            data-testid={`button-delete-flight-path-${fp.id}`}
                          >
                            <Trash2 className="h-4 w-4 text-destructive" />
                          </Button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Block Lists Section */}
            <Card data-testid="card-block-lists">
              <CardHeader>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex items-center gap-2">
                    <ShieldBan className="h-5 w-5 text-destructive" />
                    <CardTitle>My Block Lists</CardTitle>
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      resetBlockListForm();
                      setShowBlockListDialog(true);
                    }}
                    data-testid="button-create-block-list"
                  >
                    <Plus className="h-4 w-4 mr-2" />
                    Create Block List
                  </Button>
                </div>
                <CardDescription>
                  Create lists of blocked websites to apply on-demand during class. Block lists are session-based and must be manually applied from the dashboard toolbar.
                </CardDescription>
              </CardHeader>
              <CardContent>
                {blockListsError ? <p role="alert">Block Lists could not be loaded. <Button variant="link" onClick={() => retryBlockLists()}>Retry</Button></p> : blockLists.length === 0 ? (
                  <div className="text-center py-8 text-muted-foreground">
                    <ShieldBan className="h-12 w-12 mx-auto mb-3 opacity-20" />
                    <p>No Block Lists created yet</p>
                    <p className="text-sm mt-1">Create a Block List to restrict student access to specific sites</p>
                  </div>
                ) : (
                  <div className="space-y-3">
                    {blockLists.map((bl) => (
                      <div
                        key={bl.id}
                        className="flex items-center justify-between p-4 rounded-lg border bg-card hover-elevate"
                        data-testid={`block-list-${bl.id}`}
                      >
                        <div className="flex-1 min-w-0">
                          <div className="flex flex-wrap items-center gap-2 mb-1">
                            <h3 className="font-semibold">{bl.name}</h3>
                            {bl.isDefault && (
                              <Badge variant="secondary" className="text-xs">Default</Badge>
                            )}
                            {schoolLibraryEnabled && <ResourceBadge item={bl} />}
                          </div>
                          {bl.description && (
                            <p className="text-sm text-muted-foreground mb-2">{bl.description}</p>
                          )}
                          <div className="flex flex-wrap gap-1">
                            {bl.blockedDomains && bl.blockedDomains.length > 0 ? (
                              bl.blockedDomains.map((domain, idx) => (
                                <Badge key={idx} variant="destructive" className="text-xs">
                                  {domain}
                                </Badge>
                              ))
                            ) : (
                              <span className="text-xs text-muted-foreground">No domains configured</span>
                            )}
                          </div>
                        </div>
                        <div className="flex flex-wrap items-center justify-end gap-2 ml-4">
                          {schoolLibraryEnabled && bl.canShare && (
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              disabled={libraryActionMutation.isPending}
                              onClick={() => shareResource("block-lists", bl, "Block List")}
                              data-testid={`button-share-block-list-${bl.id}`}
                            >
                              <Share2 className="h-4 w-4 mr-1" />
                              {bl.visibility === "school" ? "Stop sharing" : "Share with school"}
                            </Button>
                          )}
                          {schoolLibraryEnabled && bl.canMarkOfficial && (
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              disabled={libraryActionMutation.isPending}
                              onClick={() => markResourceOfficial("block-lists", bl, "Block List")}
                              data-testid={`button-official-block-list-${bl.id}`}
                            >
                              <ShieldCheck className="h-4 w-4 mr-1" />
                              {bl.official ? "Remove official" : "Mark official"}
                            </Button>
                          )}
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            disabled={bl.canEdit === false}
                            title={bl.canEdit === false ? "Official Block Lists are managed by administrators" : undefined}
                            onClick={() => handleEditBlockList(bl)}
                            data-testid={`button-edit-block-list-${bl.id}`}
                          >
                            <Edit className="h-4 w-4" />
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            disabled={bl.canEdit === false}
                            title={bl.canEdit === false ? "Official Block Lists are managed by administrators" : undefined}
                            onClick={() => setDeleteBlockListId(bl.id)}
                            data-testid={`button-delete-block-list-${bl.id}`}
                          >
                            <Trash2 className="h-4 w-4 text-destructive" />
                          </Button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>

            {/* School Library: shared and official items from other staff in this school */}
            {schoolLibraryEnabled && (
              <Card data-testid="card-school-library">
                <CardHeader>
                  <div className="flex items-center gap-2">
                    <Library className="h-5 w-5 text-primary" />
                    <CardTitle>School Library</CardTitle>
                  </div>
                  <CardDescription>
                    Flight Paths and Block Lists that teachers in your school shared, and Official items your administrators maintain. Apply them from the Dashboard as they are, or copy one into your own tools to make a private version you can edit.
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-6">
                  <div className="space-y-3">
                    <h3 className="text-sm font-semibold">Flight Paths</h3>
                    {flightPathData.library.length === 0 ? (
                      <p className="text-sm text-muted-foreground">No shared Flight Paths yet.</p>
                    ) : flightPathData.library.map((fp) => (
                      <div
                        key={fp.id}
                        className="flex flex-wrap items-start justify-between gap-3 p-4 rounded-lg border bg-card"
                        data-testid={`library-flight-path-${fp.id}`}
                      >
                        <div className="flex-1 min-w-0">
                          <div className="flex flex-wrap items-center gap-2 mb-1">
                            <h4 className="font-semibold">{fp.flightPathName}</h4>
                            <ResourceBadge item={fp} />
                          </div>
                          {fp.ownerName && <p className="text-xs text-muted-foreground mb-1">From {fp.ownerName}</p>}
                          {fp.description && <p className="text-sm text-muted-foreground mb-2">{fp.description}</p>}
                          <div className="flex flex-wrap gap-1">
                            {fp.allowedDomains?.length > 0 ? fp.allowedDomains.map((domain, idx) => (
                              <Badge key={idx} variant="outline" className="text-xs">{domain}</Badge>
                            )) : <span className="text-xs text-muted-foreground">No domains configured</span>}
                          </div>
                        </div>
                        <div className="flex flex-wrap items-center gap-2">
                          {fp.canMarkOfficial && (
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              disabled={libraryActionMutation.isPending}
                              onClick={() => markResourceOfficial("flight-paths", fp, "Flight Path")}
                              data-testid={`button-official-flight-path-${fp.id}`}
                            >
                              <ShieldCheck className="h-4 w-4 mr-1" />
                              {fp.official ? "Remove official" : "Mark official"}
                            </Button>
                          )}
                          <Button
                            type="button"
                            size="sm"
                            disabled={libraryActionMutation.isPending}
                            onClick={() => copyResource("flight-paths", fp, "Flight Path", fp.flightPathName)}
                            data-testid={`button-copy-flight-path-${fp.id}`}
                          >
                            <Copy className="h-4 w-4 mr-1" />
                            Copy to my Flight Paths
                          </Button>
                        </div>
                      </div>
                    ))}
                  </div>
                  <div className="space-y-3">
                    <h3 className="text-sm font-semibold">Block Lists</h3>
                    {blockListData.library.length === 0 ? (
                      <p className="text-sm text-muted-foreground">No shared Block Lists yet.</p>
                    ) : blockListData.library.map((bl) => (
                      <div
                        key={bl.id}
                        className="flex flex-wrap items-start justify-between gap-3 p-4 rounded-lg border bg-card"
                        data-testid={`library-block-list-${bl.id}`}
                      >
                        <div className="flex-1 min-w-0">
                          <div className="flex flex-wrap items-center gap-2 mb-1">
                            <h4 className="font-semibold">{bl.name}</h4>
                            <ResourceBadge item={bl} />
                          </div>
                          {bl.ownerName && <p className="text-xs text-muted-foreground mb-1">From {bl.ownerName}</p>}
                          {bl.description && <p className="text-sm text-muted-foreground mb-2">{bl.description}</p>}
                          <div className="flex flex-wrap gap-1">
                            {bl.blockedDomains?.length > 0 ? bl.blockedDomains.map((domain, idx) => (
                              <Badge key={idx} variant="destructive" className="text-xs">{domain}</Badge>
                            )) : <span className="text-xs text-muted-foreground">No domains configured</span>}
                          </div>
                        </div>
                        <div className="flex flex-wrap items-center gap-2">
                          {bl.canMarkOfficial && (
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              disabled={libraryActionMutation.isPending}
                              onClick={() => markResourceOfficial("block-lists", bl, "Block List")}
                              data-testid={`button-official-block-list-${bl.id}`}
                            >
                              <ShieldCheck className="h-4 w-4 mr-1" />
                              {bl.official ? "Remove official" : "Mark official"}
                            </Button>
                          )}
                          <Button
                            type="button"
                            size="sm"
                            disabled={libraryActionMutation.isPending}
                            onClick={() => copyResource("block-lists", bl, "Block List", bl.name)}
                            data-testid={`button-copy-block-list-${bl.id}`}
                          >
                            <Copy className="h-4 w-4 mr-1" />
                            Copy to my Block Lists
                          </Button>
                        </div>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            )}

          </section>
          <section hidden={section !== "classes"} className="space-y-6" aria-label="Class setup">
            <h2 className="text-xl font-semibold">Class setup</h2>
            {/* Subgroups Section */}
            <Card data-testid="card-subgroups">
              <CardHeader>
                <div className="flex items-center gap-2">
                  <UsersRound className="h-5 w-5 text-pink-500" />
                  <CardTitle>Class Subgroups</CardTitle>
                </div>
                <CardDescription>
                  Create subgroups within your classes for differentiated instruction. Filter and apply actions to specific subgroups from the dashboard.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                {/* Group Selector */}
                <div className="space-y-2">
                  <Label htmlFor="teaching-class-selector">Class</Label>
                  <Select value={selectedGroupId} onValueChange={selectGroup}>
                    <SelectTrigger id="teaching-class-selector" data-testid="select-teaching-class">
                      <SelectValue placeholder="Select a class" />
                    </SelectTrigger>
                    <SelectContent>
                      {groups.map((group) => (
                        <SelectItem key={group.id} value={group.id}>
                          {group.name}
                        </SelectItem>
                      ))}
                      {groups.length === 0 && (
                        <div className="p-2 text-sm text-muted-foreground">
                          No classes available. Create a class first.
                        </div>
                      )}
                    </SelectContent>
                  </Select>
                </div>

                {selectedGroupId && (
                  <>
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <p className="text-sm font-medium">Subgroups</p>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          resetSubgroupForm();
                          setShowSubgroupDialog(true);
                        }}
                        data-testid="button-create-subgroup"
                      >
                        <Plus className="h-4 w-4 mr-2" />
                        Create Subgroup
                      </Button>
                    </div>

                    {subgroups.length === 0 ? (
                      <div className="text-center py-6 text-muted-foreground">
                        <UsersRound className="h-10 w-10 mx-auto mb-2 opacity-20" />
                        <p>No subgroups yet</p>
                        <p className="text-sm">Create subgroups to organize students</p>
                      </div>
                    ) : (
                      <div className="space-y-2">
                        {subgroups.map((sg) => (
                          <div
                            key={sg.id}
                            className="flex items-center justify-between p-3 rounded-lg border bg-card"
                            data-testid={`subgroup-${sg.id}`}
                          >
                            <div className="flex items-center gap-3">
                              <div
                                className="w-4 h-4 rounded-full"
                                style={{ backgroundColor: sg.color || '#9333ea' }}
                              />
                              <span className="font-medium">{sg.name}</span>
                            </div>
                            <div className="flex items-center gap-1">
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                onClick={() => handleManageMembers(sg)}
                                data-testid={`button-manage-members-${sg.id}`}
                              >
                                <UserPlus className="h-4 w-4 mr-1" />
                                Members
                              </Button>
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon"
                                onClick={() => handleEditSubgroup(sg)}
                                data-testid={`button-edit-subgroup-${sg.id}`}
                              >
                                <Edit className="h-4 w-4" />
                              </Button>
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon"
                                onClick={() => setDeleteSubgroupId(sg.id)}
                                data-testid={`button-delete-subgroup-${sg.id}`}
                              >
                                <Trash2 className="h-4 w-4 text-destructive" />
                              </Button>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </>
                )}
              </CardContent>
            </Card>

            {/* Co-teachers Section */}
            <Card data-testid="card-co-teachers">
              <CardHeader>
                <div className="flex items-center gap-2">
                  <Users className="h-5 w-5 text-sky-500" />
                  <CardTitle>Co-teachers</CardTitle>
                </div>
                <CardDescription>
                  Co-teachers can start and manage this class, including at its scheduled bell time. Official classes are managed by administrators.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                {!canManageCoTeachers && <p className="text-sm text-muted-foreground">{selectedGroupId ? 'Co-teachers for official or shared classes are managed by the class owner or school administrator.' : 'Choose a class above to view its teaching tools.'}</p>}

                {selectedGroupId && canManageCoTeachers && (
                  <>
                    <div className="space-y-2">
                      <p className="text-sm font-medium">Teachers</p>
                      {groupTeachers.length === 0 ? (
                        <p className="text-sm text-muted-foreground">No teachers assigned to this class</p>
                      ) : (
                        <div className="space-y-2">
                          {groupTeachers.map((entry) => (
                            <div
                              key={entry.teacherId}
                              className="flex items-center justify-between p-3 rounded-lg border bg-card"
                              data-testid={`co-teacher-row-${entry.teacherId}`}
                            >
                              <div className="flex items-center gap-2">
                                <span className="font-medium">{entry.teacher?.name || "Unknown teacher"}</span>
                                <Badge variant={entry.role === "primary" ? "secondary" : "outline"} className="text-xs">
                                  {entry.role === "primary" ? "Primary" : "Co-teacher"}
                                </Badge>
                              </div>
                              {entry.role !== "primary" && (
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => removeCoTeacherMutation.mutate(entry.teacherId)}
                                  disabled={removeCoTeacherMutation.isPending}
                                  data-testid={`button-remove-co-teacher-${entry.teacherId}`}
                                >
                                  <UserMinus className="h-4 w-4 mr-1" />
                                  Remove
                                </Button>
                              )}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>

                    <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
                      <div className="flex-1 space-y-2">
                        <Label>Add a co-teacher</Label>
                        <Select value={coTeacherToAdd} onValueChange={setCoTeacherToAdd}>
                          <SelectTrigger data-testid="select-co-teacher-to-add">
                            <SelectValue placeholder="Select a teacher" />
                          </SelectTrigger>
                          <SelectContent>
                            {availableCoTeachers.map((teacher) => (
                              <SelectItem key={teacher.userId} value={teacher.userId}>
                                {teacherDisplayName(teacher)}
                              </SelectItem>
                            ))}
                            {availableCoTeachers.length === 0 && (
                              <div className="p-2 text-sm text-muted-foreground">
                                No other teachers available to add.
                              </div>
                            )}
                          </SelectContent>
                        </Select>
                      </div>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => coTeacherToAdd && addCoTeacherMutation.mutate(coTeacherToAdd)}
                        disabled={!coTeacherToAdd || addCoTeacherMutation.isPending}
                        data-testid="button-add-co-teacher"
                      >
                        <UserPlus className="h-4 w-4 mr-2" />
                        Add Co-teacher
                      </Button>
                    </div>
                  </>
                )}
              </CardContent>
            </Card>

          </section>
          <section hidden={section !== "defaults"} aria-label="Personal defaults">
            <TeachingDefaults schoolId={currentUser.schoolId} viewerId={currentUser.id} active={section === 'defaults'} />
          </section>
        </div>
      </div>

      {/* Flight Path Create/Edit Dialog */}
      <Dialog open={showFlightPathDialog} onOpenChange={open => open ? setShowFlightPathDialog(true) : closeEditor(() => setShowFlightPathDialog(false))}>
        <DialogContent className="max-h-[85dvh] max-w-2xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {editingFlightPath ? "Edit Flight Path" : "Create Flight Path"}
            </DialogTitle>
            <DialogDescription>
              {editingFlightPath
                ? "Update the Flight Path configuration below."
                : preciseResourcesEnabled ? "Define the websites and resources allowed for focused student browsing." : "Define a set of allowed domains for focused student browsing."}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="flight-path-name">Flight Path Name *</Label>
              <Input
                id="flight-path-name"
                data-testid="input-flight-path-name"
                disabled={toolBusy}
                value={flightPathName}
                onChange={(e) => setFlightPathName(e.target.value)}
                placeholder="e.g., Math Research, Reading Time"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="flight-path-description">Description (optional)</Label>
              <Textarea
                id="flight-path-description"
                data-testid="textarea-flight-path-description"
                disabled={toolBusy}
                value={flightPathDescription}
                onChange={(e) => setFlightPathDescription(e.target.value)}
                placeholder="Describe the purpose of this Flight Path"
                className="min-h-[80px]"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="flight-path-domains">Allowed Domains</Label>
              <Input
                id="flight-path-domains"
                data-testid="input-flight-path-domains"
                disabled={toolBusy}
                value={flightPathAllowedDomains}
                onChange={(e) => setFlightPathAllowedDomains(e.target.value)}
                placeholder="classroom.google.com, docs.google.com, khanacademy.org"
              />
              <div className="text-xs text-muted-foreground space-y-1">
                <p>Comma-separated domains. Use specific subdomains for best control.</p>
                <p className="font-medium text-primary">Google Services Examples:</p>
                <ul className="ml-3 space-y-0.5">
                  <li>• <code className="text-xs bg-muted px-1 rounded">classroom.google.com</code> - Google Classroom only</li>
                  <li>• <code className="text-xs bg-muted px-1 rounded">docs.google.com</code> - Forms, Docs, Sheets, Slides</li>
                  <li>• <code className="text-xs bg-muted px-1 rounded">drive.google.com</code> - Google Drive only</li>
                </ul>
                <p className="text-amber-600 dark:text-amber-500 pt-1 flex items-start gap-1">
                  <AlertCircle className="h-3 w-3 mt-0.5 flex-shrink-0" />
                  <span><code className="text-xs bg-muted px-1 rounded">google.com</code> allows that website and its subdomains, including Docs and Gmail. YouTube uses the separate <code className="text-xs bg-muted px-1 rounded">youtube.com</code> website.</span>
                </p>
              </div>
            </div>
            {preciseResourcesEnabled ? (
              <div className="space-y-2">
                <Label htmlFor="flight-path-resources">Specific videos, documents and sections (optional)</Label>
                <Textarea
                  id="flight-path-resources"
                  data-testid="textarea-flight-path-resources"
                  disabled={toolBusy}
                  value={flightPathResources}
                  onChange={(e) => setFlightPathResources(e.target.value)}
                  placeholder={"https://www.youtube.com/watch?v=...\nhttps://docs.google.com/document/d/.../edit\nhttps://www.nasa.gov/solar-system"}
                  className="min-h-[96px] font-mono text-xs"
                />
                <div className="text-xs text-muted-foreground space-y-1">
                  <p>One link per line. A YouTube video, Google Doc, Slides, Sheet, Form or Drive file allows only that item. Other links define a Section: its path and paths below it. Review the normalized scope before saving.</p>
                  <p>Students whose ClassPilot extension needs an update do not receive a Flight Path with these entries; you will see who.</p>
                </div>
              </div>
            ) : editingFlightPath?.resources?.length > 0 ? (
              <p className="text-xs text-muted-foreground" data-testid="flight-path-resources-kept">
                This Flight Path also has {editingFlightPath.resources.length} specific video, document or Section entr{editingFlightPath.resources.length === 1 ? "y" : "ies"}. They are turned off for your school right now and stay unchanged when you save.
              </p>
            ) : null}
            <RestrictionScopeReview review={flightPathPreview} disabled={toolBusy} />
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => closeEditor(() => setShowFlightPathDialog(false))}
              data-testid="button-cancel-flight-path"
            >
              Cancel
            </Button>
            <Button
              type="button"
              onClick={handleSaveFlightPath}
              disabled={!flightPathName.trim() || flightPathPreview.pending || (flightPathReviewRequired && !flightPathPreview.preview) ||
                       createFlightPathMutation.isPending || updateFlightPathMutation.isPending}
              data-testid="button-save-flight-path"
            >
              <Save className="h-4 w-4 mr-2" />
              {editingFlightPath ? "Update Flight Path" : "Create Flight Path"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Flight Path Confirmation Dialog */}
      <Dialog open={!!deleteFlightPathId} onOpenChange={() => setDeleteFlightPathId(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Flight Path?</DialogTitle>
            <DialogDescription>
              This action cannot be undone. Students currently assigned to this Flight Path will no longer have domain restrictions from it.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setDeleteFlightPathId(null)}
              data-testid="button-cancel-delete-flight-path"
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={() => deleteFlightPathId && deleteFlightPathMutation.mutate(deleteFlightPathId)}
              disabled={deleteFlightPathMutation.isPending}
              data-testid="button-confirm-delete-flight-path"
            >
              <Trash2 className="h-4 w-4 mr-2" />
              Delete Flight Path
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Block List Create/Edit Dialog */}
      <Dialog open={showBlockListDialog} onOpenChange={open => open ? setShowBlockListDialog(true) : closeEditor(() => setShowBlockListDialog(false))}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              {editingBlockList ? "Edit Block List" : "Create Block List"}
            </DialogTitle>
            <DialogDescription>
              {editingBlockList
                ? "Update the Block List configuration below."
                : "Define a set of blocked domains to restrict student access during class."}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="block-list-name">Block List Name *</Label>
              <Input
                id="block-list-name"
                data-testid="input-block-list-name"
                disabled={toolBusy}
                value={blockListName}
                onChange={(e) => setBlockListName(e.target.value)}
                placeholder="e.g., AI Tools, Social Media, Gaming Sites"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="block-list-description">Description (optional)</Label>
              <Textarea
                id="block-list-description"
                data-testid="textarea-block-list-description"
                disabled={toolBusy}
                value={blockListDescription}
                onChange={(e) => setBlockListDescription(e.target.value)}
                placeholder="Describe the purpose of this Block List"
                className="min-h-[80px]"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="block-list-domains">Blocked Domains *</Label>
              <Input
                id="block-list-domains"
                data-testid="input-block-list-domains"
                disabled={toolBusy}
                value={blockListDomains}
                onChange={(e) => setBlockListDomains(e.target.value)}
                placeholder="lens.google.com, chatgpt.com, quillbot.com"
              />
              <div className="text-xs text-muted-foreground space-y-1">
                <p>Domain rules block matching websites in the monitored Chrome profile. They do not disable browser features, extensions, apps, Incognito, Guest, or other profiles.</p>
                <p className="font-medium text-destructive">Common Block Examples:</p>
                <ul className="ml-3 space-y-0.5">
                  <li>• <code className="text-xs bg-muted px-1 rounded">lens.google.com</code> — Lens website only. This blocks navigation to that website in the monitored Chrome profile. It does not disable Chrome’s built-in Lens overlay or side panel; school IT must manage built-in Chrome features separately.</li>
                  <li>• <code className="text-xs bg-muted px-1 rounded">chatgpt.com</code> - ChatGPT</li>
                  <li>• <code className="text-xs bg-muted px-1 rounded">quillbot.com</code> - QuillBot AI writing</li>
                  <li>• <code className="text-xs bg-muted px-1 rounded">discord.com</code> - Discord</li>
                </ul>
                <p className="text-amber-600 dark:text-amber-500 pt-1 flex items-start gap-1">
                  <AlertCircle className="h-3 w-3 mt-0.5 flex-shrink-0" />
                  <span>Admin-level blocks always take precedence over teacher block lists.</span>
                </p>
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => closeEditor(() => setShowBlockListDialog(false))}
              data-testid="button-cancel-block-list"
            >
              Cancel
            </Button>
            <Button
              type="button"
              onClick={handleSaveBlockList}
              disabled={!blockListName.trim() || !blockListDomains.trim() ||
                       createBlockListMutation.isPending || updateBlockListMutation.isPending}
              data-testid="button-save-block-list"
            >
              <Save className="h-4 w-4 mr-2" />
              {editingBlockList ? "Update Block List" : "Create Block List"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Block List Confirmation Dialog */}
      <Dialog open={!!deleteBlockListId} onOpenChange={() => setDeleteBlockListId(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Block List?</DialogTitle>
            <DialogDescription>
              This action cannot be undone. If this block list is currently applied to students, it will be removed from their session.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setDeleteBlockListId(null)}
              data-testid="button-cancel-delete-block-list"
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={() => deleteBlockListId && deleteBlockListMutation.mutate(deleteBlockListId)}
              disabled={deleteBlockListMutation.isPending}
              data-testid="button-confirm-delete-block-list"
            >
              <Trash2 className="h-4 w-4 mr-2" />
              Delete Block List
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Create/Edit Subgroup Dialog */}
      <Dialog open={showSubgroupDialog} onOpenChange={(open) => { if (!open) resetSubgroupForm(); setShowSubgroupDialog(open); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editingSubgroup ? "Edit Subgroup" : "Create Subgroup"}</DialogTitle>
            <DialogDescription>
              {editingSubgroup ? "Update this subgroup's details" : "Create a new subgroup for differentiated instruction"}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="subgroup-name">Subgroup Name</Label>
              <Input
                id="subgroup-name"
                disabled={toolBusy}
                value={subgroupName}
                onChange={(e) => setSubgroupName(e.target.value)}
                placeholder="e.g., Reading Group A"
                data-testid="input-subgroup-name"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="subgroup-color">Color</Label>
              <div className="flex items-center gap-3">
                <input
                  type="color"
                  id="subgroup-color"
                  disabled={toolBusy}
                value={subgroupColor}
                  onChange={(e) => setSubgroupColor(e.target.value)}
                  className="w-12 h-10 rounded cursor-pointer"
                  data-testid="input-subgroup-color"
                />
                <div className="flex gap-2">
                  {['#ef4444', '#f97316', '#eab308', '#22c55e', '#3b82f6', '#8b5cf6', '#ec4899'].map((color) => (
                    <button
                      key={color}
                      type="button"
                      className={`w-8 h-8 rounded-full border-2 ${subgroupColor === color ? 'border-foreground' : 'border-transparent'}`}
                      style={{ backgroundColor: color }}
                      onClick={() => setSubgroupColor(color)}
                    />
                  ))}
                </div>
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => { resetSubgroupForm(); setShowSubgroupDialog(false); }}
              data-testid="button-cancel-subgroup"
            >
              Cancel
            </Button>
            <Button
              type="button"
              onClick={handleSaveSubgroup}
              disabled={createSubgroupMutation.isPending || updateSubgroupMutation.isPending || !subgroupName.trim()}
              data-testid="button-save-subgroup"
            >
              <Save className="h-4 w-4 mr-2" />
              {editingSubgroup ? "Update" : "Create"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Subgroup Confirmation Dialog */}
      <Dialog open={!!deleteSubgroupId} onOpenChange={() => setDeleteSubgroupId(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Subgroup?</DialogTitle>
            <DialogDescription>
              This will remove the subgroup and all member assignments. This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setDeleteSubgroupId(null)}
              data-testid="button-cancel-delete-subgroup"
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={() => deleteSubgroupId && deleteSubgroupMutation.mutate(deleteSubgroupId)}
              disabled={deleteSubgroupMutation.isPending}
              data-testid="button-confirm-delete-subgroup"
            >
              <Trash2 className="h-4 w-4 mr-2" />
              Delete Subgroup
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Manage Subgroup Members Dialog */}
      <Dialog open={showManageMembersDialog} onOpenChange={open => open ? setShowManageMembersDialog(true) : closeEditor(() => { setManagingSubgroup(null); setShowManageMembersDialog(false); })}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>
              <div className="flex items-center gap-2">
                <div
                  className="w-4 h-4 rounded-full"
                  style={{ backgroundColor: managingSubgroup?.color || '#9333ea' }}
                />
                {managingSubgroup?.name} - Members
              </div>
            </DialogTitle>
            <DialogDescription>
              Add or remove students from this subgroup
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-[400px] overflow-y-auto space-y-2 py-4">
            {groupStudents.length === 0 ? (
              <p className="text-center text-muted-foreground py-4">No students in this class</p>
            ) : (
              groupStudents.map((student) => {
                const isMember = subgroupMembers.includes(student.id);
                return (
                  <div
                    key={student.id}
                    className="flex items-center justify-between p-3 rounded-lg border"
                    data-testid={`member-row-${student.id}`}
                  >
                    <div>
                      <p className="font-medium">{student.studentName || student.id}</p>
                      <p className="text-xs text-muted-foreground">{student.studentEmail}</p>
                    </div>
                    <Button
                      type="button"
                      size="sm"
                      variant={isMember ? "destructive" : "outline"}
                      onClick={() => {
                        if (isMember && managingSubgroup) {
                          removeSubgroupMemberMutation.mutate({ subgroupId: managingSubgroup.id, studentId: student.id });
                        } else if (managingSubgroup) {
                          addSubgroupMemberMutation.mutate({ subgroupId: managingSubgroup.id, studentId: student.id });
                        }
                      }}
                      disabled={addSubgroupMemberMutation.isPending || removeSubgroupMemberMutation.isPending}
                      data-testid={`button-toggle-member-${student.id}`}
                    >
                      {isMember ? (
                        <>
                          <UserMinus className="h-4 w-4 mr-1" />
                          Remove
                        </>
                      ) : (
                        <>
                          <UserPlus className="h-4 w-4 mr-1" />
                          Add
                        </>
                      )}
                    </Button>
                  </div>
                );
              })
            )}
          </div>
          <DialogFooter>
            <Button onClick={() => closeEditor(() => setShowManageMembersDialog(false))} data-testid="button-close-members">
              Done
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
