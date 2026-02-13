import { usePassPilotAuth } from '../../../../hooks/usePassPilotAuth';
import { Card, CardContent, CardHeader, CardTitle } from '../../../../components/ui/card';

export function BillingView() {
  const { school } = usePassPilotAuth();
  return (
    <div className="p-4 space-y-4">
      <h2 className="text-xl font-semibold">Billing</h2>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Invoice-Based Billing</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm text-muted-foreground">
          <p>Billing for {school?.name ?? "your school"} is handled via invoice.</p>
          <p>Invoices are sent to your school's billing contact email. If you have questions about your billing, contact support.</p>
        </CardContent>
      </Card>
    </div>
  );
}

export default BillingView;
