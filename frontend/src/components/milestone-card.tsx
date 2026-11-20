"use client";

import { useMemo } from "react";
import { motion } from "framer-motion";
import { Trophy, Target, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";

type Milestone = {
  id: string;
  title: string;
  description?: string | null;
  targetAmount: string;
  currentAmount: string;
  assetCode: string;
  status: string;
  createdAt: string;
};

type MilestoneCardProps = {
  milestone: Milestone;
  index?: number;
};

function ConfettiBurst() {
  const particles = useMemo(() => {
    const colors = [
      "#a5ffd6", // mint
      "#ffc857", // gold
      "#dff6ff", // sky
      "#7dd3fc", // sky-300
      "#f0abfc", // fuchsia-300
      "#fde68a", // amber-200
      "#a7f3d0", // emerald-200
      "#bfdbfe", // blue-200
    ];

    return Array.from({ length: 40 }, (_, i) => ({
      id: i,
      x: (Math.random() - 0.5) * 300,
      y: (Math.random() - 0.5) * 300 - 80,
      rotate: Math.random() * 720 - 360,
      scale: Math.random() * 0.6 + 0.4,
      color: colors[Math.floor(Math.random() * colors.length)],
      width: Math.random() * 8 + 4,
      height: Math.random() * 6 + 3,
      delay: Math.random() * 0.3,
      duration: Math.random() * 0.6 + 0.8,
    }));
  }, []);

  return (
    <div className="absolute inset-0 pointer-events-none overflow-hidden">
      {particles.map((particle) => (
        <motion.div
          key={particle.id}
          className="absolute left-1/2 top-1/2 rounded-sm"
          style={{
            width: particle.width,
            height: particle.height,
            backgroundColor: particle.color,
          }}
          initial={{ opacity: 1, x: 0, y: 0, rotate: 0, scale: 0 }}
          animate={{
            opacity: [1, 1, 0],
            x: particle.x,
            y: particle.y,
            rotate: particle.rotate,
            scale: [0, particle.scale, 0],
          }}
          transition={{
            duration: particle.duration,
            delay: particle.delay,
            ease: "easeOut",
          }}
        />
      ))}
    </div>
  );
}

export function MilestoneCard({ milestone, index = 0 }: MilestoneCardProps) {
  const current = parseFloat(milestone.currentAmount);
  const target = parseFloat(milestone.targetAmount);
  const progress = Number.isFinite(current) && Number.isFinite(target) && target > 0
    ? Math.min((current / target) * 100, 100)
    : 0;
  const isReached = milestone.status === "reached" || progress >= 100;

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, delay: index * 0.08 }}
      className={cn(
        "group relative rounded-2xl border p-4 sm:p-5 transition-colors duration-300",
        isReached
          ? "border-mint/30 bg-mint/[0.04] ring-1 ring-mint/10"
          : "border-white/10 bg-white/5 hover:border-white/20"
      )}
    >
      {isReached && <ConfettiBurst />}

      {isReached && (
        <div className="absolute -top-2 -right-2 z-10">
          <motion.span
            initial={{ scale: 0, rotate: -20 }}
            animate={{ scale: 1, rotate: 0 }}
            transition={{ type: "spring", stiffness: 400, damping: 15, delay: index * 0.08 + 0.2 }}
            className="inline-flex items-center gap-1 rounded-full bg-mint px-2.5 py-1 text-[10px] font-extrabold uppercase tracking-widest text-ink shadow-lg shadow-mint/30"
          >
            <Trophy size={11} />
            Reached
          </motion.span>
        </div>
      )}

      <div className="flex items-start justify-between gap-2 mb-3">
        <div className="flex-1 min-w-0">
          <h4 className="text-sm font-semibold text-white truncate">
            {milestone.title}
          </h4>
          {milestone.description && (
            <p className="text-xs text-steel mt-1 line-clamp-2">
              {milestone.description}
            </p>
          )}
        </div>

        {!isReached && (
          <div className="flex-shrink-0">
            <motion.div
              animate={{ rotate: [0, -5, 5, -3, 0] }}
              transition={{ repeat: Infinity, duration: 3, ease: "easeInOut" }}
            >
              <Target size={18} className="text-steel/50" />
            </motion.div>
          </div>
        )}
      </div>

      <div className="space-y-2">
        <div className="relative w-full h-2 rounded-full bg-white/5 overflow-hidden">
          <motion.div
            initial={{ width: 0 }}
            animate={{ width: `${progress}%` }}
            transition={{ duration: 1, delay: index * 0.08 + 0.1, ease: "easeOut" }}
            className={cn(
              "h-full transition-colors duration-500",
              isReached
                ? "bg-gradient-to-r from-mint via-mint to-gold"
                : "bg-gradient-to-r from-mint/80 to-mint"
            )}
          />

          {isReached && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ delay: 0.5, duration: 0.3 }}
              className="absolute inset-0 bg-gradient-to-r from-transparent via-white/20 to-transparent"
              style={{
                animation: "shimmer 2s ease-in-out infinite",
              }}
            />
          )}
        </div>

        <div className="flex items-center justify-between text-xs">
          <span className={cn(
            "font-medium tabular-nums",
            isReached ? "text-mint" : "text-steel"
          )}>
            {current.toLocaleString(undefined, { maximumFractionDigits: 7 })} / {target.toLocaleString(undefined, { maximumFractionDigits: 7 })}{" "}
            <span className={cn(
              "font-semibold",
              isReached ? "text-mint" : "text-sky/60"
            )}>
              {milestone.assetCode}
            </span>
          </span>

          <motion.span
            key={Math.round(progress * 100) / 100}
            initial={{ scale: 1.3 }}
            animate={{ scale: 1 }}
            className={cn(
              "font-bold tabular-nums",
              isReached ? "text-mint" : "text-steel"
            )}
          >
            {isReached && <Sparkles size={12} className="inline mr-1 text-gold" />}
            {progress < 0.01 && progress > 0 ? progress.toFixed(4) : progress < 1 ? progress.toFixed(2) : Math.round(progress)}%
          </motion.span>
        </div>
      </div>
    </motion.div>
  );
}

export function MilestoneListSkeleton() {
  return (
    <div className="px-2 space-y-4">
      <div className="h-3 w-28 bg-white/10 rounded animate-pulse" />
      <div className="space-y-4">
        {[1, 2].map((i) => (
          <div
            key={i}
            className="rounded-2xl border border-white/10 bg-white/5 p-5 space-y-4"
          >
            <div className="space-y-2">
              <div className="h-4 w-48 bg-white/10 rounded animate-pulse" />
              <div className="h-3 w-64 bg-white/10 rounded animate-pulse" />
            </div>
            <div className="space-y-2">
              <div className="h-2 w-full rounded-full bg-white/5 overflow-hidden">
                <div className="h-full w-1/3 bg-white/10 animate-pulse" />
              </div>
              <div className="flex justify-between">
                <div className="h-3 w-32 bg-white/10 rounded animate-pulse" />
                <div className="h-3 w-8 bg-white/10 rounded animate-pulse" />
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
