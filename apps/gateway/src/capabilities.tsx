import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { FieldDescription } from "@/components/ui/field";
import { getDeploymentCapabilities } from "./asset-api";

export function useDeploymentCapabilities() {
  return useQuery({
    queryKey: ["deployment-capabilities"],
    queryFn: getDeploymentCapabilities,
    staleTime: 60_000,
    retry: false,
  });
}

export function CapabilityNotice({
  capabilities,
  available,
  unavailable,
  id,
}: {
  capabilities: ReturnType<typeof useDeploymentCapabilities>;
  available: boolean;
  unavailable: string;
  id: string;
}) {
  if (capabilities.isPending)
    return (
      <FieldDescription id={id}>
        <output>Checking email availability…</output>
      </FieldDescription>
    );
  if (capabilities.isError)
    return (
      <FieldDescription id={id} role="alert">
        Could not check email availability.{" "}
        <Button
          type="button"
          variant="link"
          size="xs"
          disabled={capabilities.isFetching}
          onClick={() => void capabilities.refetch()}
        >
          Retry
        </Button>
      </FieldDescription>
    );
  if (!available)
    return <FieldDescription id={id}>{unavailable}</FieldDescription>;
  return null;
}
