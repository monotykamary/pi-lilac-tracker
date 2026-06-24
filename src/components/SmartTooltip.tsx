import { useRef, useCallback, useState, useEffect, type CSSProperties, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'framer-motion';

interface SmartTooltipProps {
  children: ReactNode;
  content: ReactNode;
  preferredPlacement?: 'top' | 'bottom';
  gap?: number;
  minWidth?: number;
  maxWidth?: number;
}

const HIDE_DELAY_MS = 120;

let activeHide: (() => void) | null = null;

export function SmartTooltip({
  children,
  content,
  preferredPlacement = 'bottom',
  gap = 10,
  minWidth = 240,
  maxWidth = 340,
}: SmartTooltipProps) {
  const triggerRef = useRef<HTMLDivElement>(null);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const ourHideRef = useRef<(() => void) | null>(null);

  const [visible, setVisible] = useState(false);
  const [style, setStyle] = useState<CSSProperties>({ opacity: 0, pointerEvents: 'none' });
  const [arrowDir, setArrowDir] = useState<'up' | 'down'>('up');
  const [arrowOffset, setArrowOffset] = useState(0);

  const clearHideTimer = useCallback(() => {
    if (hideTimerRef.current) {
      clearTimeout(hideTimerRef.current);
      hideTimerRef.current = null;
    }
  }, []);

  const doHide = useCallback(() => {
    clearHideTimer();
    if (activeHide === ourHideRef.current) activeHide = null;
    setVisible(false);
    setStyle({ opacity: 0, pointerEvents: 'none' });
  }, [clearHideTimer]);

  useEffect(() => {
    ourHideRef.current = doHide;
  }, [doHide]);

  const scheduleHide = useCallback(() => {
    clearHideTimer();
    hideTimerRef.current = setTimeout(() => doHide(), HIDE_DELAY_MS);
  }, [clearHideTimer, doHide]);

  const measureAndShow = useCallback(() => {
    clearHideTimer();
    if (activeHide && activeHide !== ourHideRef.current) activeHide();
    activeHide = ourHideRef.current;

    const trigger = triggerRef.current;
    if (!trigger) return;
    const sizer = trigger.querySelector('[data-tooltip-sizer]') as HTMLElement | null;
    if (!sizer) return;

    const tRect = trigger.getBoundingClientRect();
    const sRect = sizer.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const pad = 14;

    const width = Math.max(minWidth, Math.min(sRect.width + 1, maxWidth));

    const spaceBelow = vh - tRect.bottom;
    const spaceAbove = tRect.top;
    const needed = sRect.height + gap + pad;

    let placement = preferredPlacement;
    if (preferredPlacement === 'bottom' && spaceBelow < needed) {
      if (spaceAbove >= needed) placement = 'top';
    } else if (preferredPlacement === 'top' && spaceAbove < needed) {
      if (spaceBelow >= needed) placement = 'bottom';
    }

    setArrowDir(placement === 'bottom' ? 'up' : 'down');

    const top = placement === 'bottom' ? tRect.bottom + gap : undefined;
    const bottom = placement === 'top' ? vh - tRect.top + gap : undefined;

    const centre = tRect.left + tRect.width / 2;
    let left = centre - width / 2;
    if (left < pad) left = pad;
    if (left + width > vw - pad) left = vw - pad - width;

    setArrowOffset(centre - left);
    setStyle({
      position: 'fixed',
      top,
      bottom,
      left,
      width,
      opacity: 1,
      pointerEvents: 'auto',
    });
    setVisible(true);
  }, [clearHideTimer, preferredPlacement, gap, minWidth, maxWidth]);

  useEffect(() => {
    if (!visible) return;
    const handler = () => { clearHideTimer(); doHide(); };
    window.addEventListener('scroll', handler, true);
    window.addEventListener('resize', handler);
    return () => {
      window.removeEventListener('scroll', handler, true);
      window.removeEventListener('resize', handler);
    };
  }, [visible, doHide, clearHideTimer]);

  useEffect(() => {
    return () => {
      clearHideTimer();
      if (activeHide === ourHideRef.current) activeHide = null;
    };
  }, [clearHideTimer]);

  const arrowStyle: CSSProperties = {
    position: 'absolute',
    width: 8,
    height: 8,
    left: arrowOffset,
    transform: 'translateX(-50%) rotate(45deg)',
    background: 'var(--surface)',
    borderStyle: 'solid',
    borderColor: 'var(--border)',
  };

  if (arrowDir === 'up') {
    arrowStyle.top = -4;
    arrowStyle.borderWidth = '1px 0 0 1px';
  } else {
    arrowStyle.bottom = -4;
    arrowStyle.borderWidth = '0 1px 1px 0';
  }

  return (
    <div
      ref={triggerRef}
      style={{ position: 'relative', display: 'inline-block', width: '100%' }}
      onMouseEnter={measureAndShow}
      onMouseLeave={scheduleHide}
      onFocus={measureAndShow}
      onBlur={scheduleHide}
    >
      {children}
      <div
        data-tooltip-sizer
        style={{
          position: 'fixed',
          opacity: 0,
          pointerEvents: 'none',
          minWidth,
          maxWidth,
          visibility: 'hidden',
          left: -9999,
          top: -9999,
        }}
        aria-hidden="true"
      >
        {content}
      </div>
      <AnimatePresence>
        {visible && (
          <motion.div
            key="tooltip"
            initial={{ opacity: 0, scale: 0.96, y: arrowDir === 'up' ? 6 : -6 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.98, y: arrowDir === 'up' ? 4 : -4, pointerEvents: 'none' }}
            transition={{ type: 'spring', stiffness: 400, damping: 28, mass: 0.8 }}
            style={{ ...style, zIndex: 100 }}
            onMouseEnter={clearHideTimer}
            onMouseLeave={scheduleHide}
          >
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.15 }}
              style={arrowStyle}
            />
            {content}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
