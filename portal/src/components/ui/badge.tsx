import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../../lib/utils";

// Status chips: the light tints of the two brand colours, and a neutral one.
const badgeVariants = cva("inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium whitespace-nowrap", {
  variants: {
    tone: {
      phosphor: "bg-phosphor-chip text-phosphor",
      amber: "bg-amber-chip text-amber",
      neutral: "bg-neutral-chip text-dim"
    }
  },
  defaultVariants: { tone: "neutral" }
});

export function Badge({ className, tone, ...props }: React.HTMLAttributes<HTMLSpanElement> & VariantProps<typeof badgeVariants>) {
  return <span className={cn(badgeVariants({ tone }), className)} {...props} />;
}
