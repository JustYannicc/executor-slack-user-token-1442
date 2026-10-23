import type { AccountFormFields } from "../../contracts/credentials.ts";
import { Input } from "@executor-js/ui/components/input";
import { HugeiconsIcon } from "@hugeicons/react";
import { SquareLock02Icon, ViewIcon } from "@hugeicons/core-free-icons";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./tooltip.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@executor-js/ui/components/select";
import { useProductBrand } from "../hooks/product-brand.ts";

/** A field's title, or its name in words: `apiKey` reads "Api Key". */
export const fieldLabel = (name: string, field: { readonly title?: string | undefined }) =>
  field.title ?? name.replace(/([A-Z])/g, " $1").replace(/^./, (s) => s.toUpperCase());

/**
 * Whether the app gets a secret field's value. A provider with hosts hides unmarked fields behind
 * placeholders; its `raw()` fields, and every field of a provider without hosts, are readable.
 */
function FieldAccess({
  hidden,
  hosts,
}: {
  readonly hidden: boolean;
  readonly hosts?: readonly string[] | undefined;
}) {
  const brand = useProductBrand();
  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            tabIndex={0}
            role="img"
            aria-label={hidden ? "Hidden from app" : "Readable by app"}
            data-field-access={hidden ? "hidden" : "readable"}
            className={`ml-auto flex cursor-help items-center ${
              hidden
                ? "text-emerald-700 dark:text-emerald-400"
                : "text-amber-700 dark:text-amber-400"
            }`}
          >
            <HugeiconsIcon icon={hidden ? SquareLock02Icon : ViewIcon} className="size-3.5" />
          </span>
        </TooltipTrigger>
        <TooltipContent className="max-w-64">
          {hidden
            ? `The app and your agent only see a placeholder. ${brand.name} swaps in the real value on requests to ${hosts?.join(", ")}.`
            : "The app reads this value and can send it anywhere."}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

/** Empty inputs for new credentials; saved values never enter the form. */
export function CredentialFields({
  fields,
  values,
  onChange,
  pending,
  hosts,
}: {
  readonly fields: AccountFormFields;
  /** The provider's credential hosts. Without them the app reads every secret. */
  readonly hosts?: readonly string[] | undefined;
  readonly values: Readonly<Record<string, string>>;
  readonly onChange: (values: Readonly<Record<string, string>>) => void;
  readonly pending: boolean;
}) {
  return (
    <>
      {Object.entries(fields.properties).map(([name, field]) => (
        <label
          className="field-label flex flex-col gap-2.25 text-[13px] font-medium [&_[data-slot='select-trigger']]:w-full"
          key={name}
        >
          <span className="flex w-full items-center gap-1.5">
            {fieldLabel(name, field)}
            {field.type === "string" && !fields.plain?.includes(name) && (
              <FieldAccess
                hidden={hosts !== undefined && !fields.raw?.includes(name)}
                hosts={hosts}
              />
            )}
          </span>
          <div data-private>
            {field.type === "boolean" || field.enum ? (
              <Select
                value={values[name] ?? ""}
                onValueChange={(value) => onChange({ ...values, [name]: value })}
                disabled={pending}
                required={fields.required?.includes(name) === true}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Choose a value" />
                </SelectTrigger>
                <SelectContent data-private>
                  {(field.enum ?? [true, false]).map((value) => (
                    <SelectItem value={String(value)} key={String(value)}>
                      {String(value)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <Input
                type={
                  field.type !== "string"
                    ? "number"
                    : fields.plain?.includes(name)
                      ? "text"
                      : "password"
                }
                autoComplete="off"
                value={values[name] ?? ""}
                onChange={(event) => onChange({ ...values, [name]: event.target.value })}
                required={fields.required?.includes(name) === true}
                step={field.type === "number" ? "any" : undefined}
                disabled={pending}
              />
            )}
          </div>
          {field.description && (
            <span className="field-hint text-muted-foreground text-[12px] font-normal leading-[1.5] [.mcp-install-content_>_&]:mt-5">
              {field.description}
            </span>
          )}
        </label>
      ))}
    </>
  );
}
