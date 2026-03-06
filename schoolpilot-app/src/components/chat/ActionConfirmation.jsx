import { Button } from "../ui/button";
import { Card, CardContent, CardFooter } from "../ui/card";
import { AlertTriangle } from "lucide-react";

export function ActionConfirmation({ action, onConfirm, onCancel, disabled }) {
  const formatParams = (params) => {
    if (!params) return null;
    return Object.entries(params)
      .filter(([, v]) => v != null && v !== "")
      .map(([key, value]) => (
        <div key={key} className="flex justify-between text-xs">
          <span className="text-muted-foreground capitalize">
            {key.replace(/([A-Z])/g, " $1").trim()}
          </span>
          <span className="font-medium max-w-[60%] text-right truncate">
            {Array.isArray(value) ? value.join(", ") : String(value)}
          </span>
        </div>
      ));
  };

  return (
    <Card className="border-amber-200 bg-amber-50 dark:border-amber-800 dark:bg-amber-950">
      <CardContent className="pt-4 pb-2 space-y-2">
        <div className="flex items-center gap-2 text-sm font-medium text-amber-700 dark:text-amber-300">
          <AlertTriangle className="h-4 w-4" />
          Confirm Action
        </div>
        {action.description && (
          <p className="text-sm text-foreground">{action.description}</p>
        )}
        <div className="space-y-1">{formatParams(action.params)}</div>
      </CardContent>
      <CardFooter className="gap-2 pb-3 pt-0">
        <Button size="sm" onClick={onConfirm} disabled={disabled}>
          Yes, do it
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={onCancel}
          disabled={disabled}
        >
          Cancel
        </Button>
      </CardFooter>
    </Card>
  );
}
