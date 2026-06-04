import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { ArrowLeft, Download, FileArchive, RefreshCw, ShieldAlert } from "lucide-react";
import { apiRequest, queryClient } from "../../../lib/queryClient";
import { Button } from "../../../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../../../components/ui/card";
import { Badge } from "../../../components/ui/badge";
import { Textarea } from "../../../components/ui/textarea";
import { ThemeToggle } from "../../../components/ThemeToggle";
import { useToast } from "../../../hooks/use-toast";

function severityVariant(severity) {
  return severity === "critical" || severity === "high" ? "destructive" : "secondary";
}

export default function SafetyCenter() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const [reviewNotes, setReviewNotes] = useState({});
  const [packet, setPacket] = useState(null);

  const { data: casesData, refetch: refetchCases } = useQuery({
    queryKey: ["/api/classpilot/safety-cases"],
    queryFn: () => apiRequest("GET", "/classpilot/safety-cases"),
  });
  const { data: decisionsData, refetch: refetchDecisions } = useQuery({
    queryKey: ["/api/classpilot/ai-decisions"],
    queryFn: () => apiRequest("GET", "/classpilot/ai-decisions"),
  });

  const reviewMutation = useMutation({
    mutationFn: ({ id, reviewStatus }) => apiRequest("PATCH", `/classpilot/ai-decisions/${id}/review`, {
      reviewStatus,
      reviewNote: reviewNotes[id] || undefined,
    }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/classpilot/ai-decisions"] });
      toast({ title: "Review saved" });
    },
    onError: (error) => toast({ variant: "destructive", title: "Review failed", description: error.message }),
  });

  const packetMutation = useMutation({
    mutationFn: ({ studentId, caseId }) => {
      const to = new Date();
      const from = new Date(to.getTime() - 14 * 24 * 60 * 60 * 1000);
      return apiRequest("POST", "/classpilot/evidence-packets", {
        studentId,
        caseId,
        from: from.toISOString(),
        to: to.toISOString(),
        includeFlags: { screenshots: true, mailpilot: true, attendance: true, passes: true, dismissal: true },
      });
    },
    onSuccess: (data) => {
      setPacket(data);
      toast({ title: "Evidence packet created", description: `${data.eventCount} event(s) included` });
    },
    onError: (error) => toast({ variant: "destructive", title: "Packet failed", description: error.message }),
  });

  const refreshAll = () => {
    refetchCases();
    refetchDecisions();
  };

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-6 py-4">
          <div className="flex items-center gap-3">
            <Button variant="ghost" size="icon" onClick={() => navigate("/classpilot/admin")}>
              <ArrowLeft className="h-5 w-5" />
            </Button>
            <div>
              <h1 className="text-xl font-semibold">Safety Center</h1>
              <p className="text-xs text-muted-foreground">Open cases, explainable AI decisions, and evidence exports</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <ThemeToggle />
            <Button variant="outline" onClick={refreshAll}>
              <RefreshCw className="mr-2 h-4 w-4" />
              Refresh
            </Button>
          </div>
        </div>
      </header>

      <main className="mx-auto grid max-w-6xl gap-5 px-6 py-6 lg:grid-cols-[360px_1fr]">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <ShieldAlert className="h-5 w-5" />
              Open Cases
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {(casesData?.cases || []).length === 0 ? (
              <p className="text-sm text-muted-foreground">No open safety cases.</p>
            ) : (
              casesData.cases.map((safetyCase) => (
                <div key={safetyCase.id} className="rounded-md border p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <p className="font-medium">{safetyCase.studentName}</p>
                      <p className="text-sm text-muted-foreground">{safetyCase.title}</p>
                    </div>
                    <Badge variant={severityVariant(safetyCase.severity)}>{safetyCase.severity}</Badge>
                  </div>
                  <Button
                    className="mt-3 w-full"
                    size="sm"
                    variant="outline"
                    onClick={() => packetMutation.mutate({ studentId: safetyCase.studentId, caseId: safetyCase.id })}
                    disabled={packetMutation.isPending}
                  >
                    <FileArchive className="mr-2 h-4 w-4" />
                    Create Packet
                  </Button>
                </div>
              ))
            )}
            {packet?.packetId && (
              <Button asChild className="w-full">
                <a href={`/api/classpilot/evidence-packets/${packet.packetId}/download`}>
                  <Download className="mr-2 h-4 w-4" />
                  Download Packet
                </a>
              </Button>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Explainable AI Decisions</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {(decisionsData?.decisions || []).length === 0 ? (
              <p className="text-sm text-muted-foreground">No AI safety decisions found.</p>
            ) : (
              decisionsData.decisions.map((decision) => (
                <div key={decision.id} className="rounded-md border p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge variant={decision.safetyAlert ? "destructive" : "secondary"}>
                          {decision.safetyAlert || decision.category || "unknown"}
                        </Badge>
                        {decision.confidence ? <Badge variant="outline">{decision.confidence}% confidence</Badge> : null}
                        {decision.reviewStatus ? <Badge variant="secondary">{decision.reviewStatus}</Badge> : null}
                      </div>
                      <p className="mt-2 truncate font-medium">{decision.title || decision.url}</p>
                      <p className="mt-1 break-all text-xs text-muted-foreground">{decision.url}</p>
                      <div className="mt-3 grid gap-2 text-sm md:grid-cols-3">
                        <div>
                          <p className="text-xs text-muted-foreground">Why flagged</p>
                          <p>{decision.reasoning || decision.matchedRule || "Rule or AI classifier matched this activity."}</p>
                        </div>
                        <div>
                          <p className="text-xs text-muted-foreground">Action</p>
                          <p>{decision.actionTaken || "review"}</p>
                        </div>
                        <div>
                          <p className="text-xs text-muted-foreground">Teacher Intent</p>
                          <p>{decision.teacherIntentSource || "none recorded"}</p>
                        </div>
                      </div>
                    </div>
                  </div>
                  <Textarea
                    className="mt-3"
                    rows={2}
                    placeholder="Review note"
                    value={reviewNotes[decision.id] || ""}
                    onChange={(event) => setReviewNotes((prev) => ({ ...prev, [decision.id]: event.target.value }))}
                  />
                  <div className="mt-3 flex flex-wrap gap-2">
                    {["confirmed", "dismissed", "escalated"].map((reviewStatus) => (
                      <Button
                        key={reviewStatus}
                        size="sm"
                        variant={reviewStatus === "escalated" ? "default" : "outline"}
                        onClick={() => reviewMutation.mutate({ id: decision.id, reviewStatus })}
                        disabled={reviewMutation.isPending}
                      >
                        {reviewStatus}
                      </Button>
                    ))}
                  </div>
                </div>
              ))
            )}
          </CardContent>
        </Card>
      </main>
    </div>
  );
}
