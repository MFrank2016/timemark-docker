import {
  Fragment,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { MoreVertical, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export interface ActionMenuItem {
  label: string;
  icon: LucideIcon;
  onSelect: () => void;
  danger?: boolean;
  dividerBefore?: boolean;
}

export interface ActionMenuProps {
  items: ActionMenuItem[];
  triggerLabel: string;
  icon?: LucideIcon;
  align?: "start" | "end";
  className?: string;
  panelClassName?: string;
}

export function ActionMenu({
  items,
  triggerLabel,
  icon: TriggerIcon = MoreVertical,
  align = "end",
  className,
  panelClassName,
}: ActionMenuProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const hasOpened = useRef(false);
  const restoreFocus = useRef(true);
  const menuId = useId();

  const close = (returnFocus = true) => {
    restoreFocus.current = returnFocus;
    setOpen(false);
  };

  // 关闭后焦点回触发器；若选中项已把焦点交给 Dialog 等外部元素则不抢
  useEffect(() => {
    if (open) {
      hasOpened.current = true;
      return;
    }
    if (!hasOpened.current || !restoreFocus.current) return;
    const active = document.activeElement;
    if (
      active &&
      active !== document.body &&
      !rootRef.current?.contains(active)
    )
      return;
    triggerRef.current?.focus();
  }, [open]);

  // 打开后焦点落到首个菜单项，键盘用户可直接方向键移动
  useEffect(() => {
    if (open)
      panelRef.current
        ?.querySelector<HTMLElement>('[role="menuitem"]')
        ?.focus();
  }, [open]);

  // 外部 pointerdown（非 click）关闭
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) close(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  const onRootKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!open) return;
    if (event.key === "Escape") {
      event.preventDefault();
      close();
      return;
    }
    if (event.key === "Tab") {
      // Tab 离开即关；关闭后焦点回触发器
      event.preventDefault();
      close();
      return;
    }
    const nodes = Array.from(
      panelRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ??
        [],
    );
    if (nodes.length === 0) return;
    const current = nodes.indexOf(document.activeElement as HTMLElement);
    if (event.key === "ArrowDown") {
      event.preventDefault();
      nodes[(current + 1) % nodes.length].focus();
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      nodes[(current - 1 + nodes.length) % nodes.length].focus();
    } else if (event.key === "Home") {
      event.preventDefault();
      nodes[0].focus();
    } else if (event.key === "End") {
      event.preventDefault();
      nodes[nodes.length - 1].focus();
    }
  };

  return (
    <div
      ref={rootRef}
      className={cn("relative", className)}
      onKeyDown={onRootKeyDown}
    >
      <Button
        ref={triggerRef}
        type="button"
        variant="ghost"
        size="icon"
        aria-label={triggerLabel}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={(event) => {
          event.stopPropagation();
          setOpen((prev) => !prev);
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        <TriggerIcon size={18} />
      </Button>

      {open && (
        <div
          id={menuId}
          ref={panelRef}
          role="menu"
          aria-label={triggerLabel}
          className={cn(
            "absolute top-full z-50 mt-2 min-w-[11rem] rounded-2xl p-1.5 glass-panel ring-1 ring-black/5 dark:ring-white/10 shadow-[0_16px_40px_rgb(0,0,0,0.12)] dark:shadow-[0_16px_40px_rgb(0,0,0,0.6)]",
            align === "end" ? "right-0" : "left-0",
            panelClassName,
          )}
        >
          {items.map((item) => {
            const ItemIcon = item.icon;
            return (
              <Fragment key={item.label}>
                {item.dividerBefore && (
                  <div
                    role="separator"
                    className="my-1 h-px bg-slate-200/70 dark:bg-white/10"
                  />
                )}
                <button
                  type="button"
                  role="menuitem"
                  onClick={(event) => {
                    event.stopPropagation();
                    item.onSelect();
                    close();
                  }}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-xl px-3 py-2.5 text-left text-sm font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/40",
                    item.danger
                      ? "text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-900/30"
                      : "text-slate-700 hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-white/10",
                  )}
                >
                  <ItemIcon size={16} />
                  <span>{item.label}</span>
                </button>
              </Fragment>
            );
          })}
        </div>
      )}
    </div>
  );
}
