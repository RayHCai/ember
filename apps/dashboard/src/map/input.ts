import {
    Entity,
    ScreenSpaceEventHandler,
    ScreenSpaceEventType,
    defined,
    type Cartesian2,
    type Viewer,
} from 'cesium';
import { useEffect, useRef } from 'react';
import { pickPoint, type PickedPoint } from './pick';
import { useMap } from './viewer';

export interface MapInput {
    onClick?: (point: PickedPoint | null, entity: Entity | undefined) => void;
    onDoubleClick?: (point: PickedPoint | null, entity: Entity | undefined) => void;
    onRightClick?: (point: PickedPoint | null, entity: Entity | undefined) => void;
    /** Pointer moved over the map; `screen` is in canvas pixels. */
    onMove?: (point: PickedPoint | null, entity: Entity | undefined, screen: Cartesian2) => void;
    onLeave?: () => void;
    draggable?: (entity: Entity) => boolean;
    onDrag?: (entity: Entity, point: PickedPoint) => void;
    onDragEnd?: (entity: Entity) => void;
    /** Cursor over empty map, and over entities `hoverable` accepts. */
    cursor?: string;
    hoverable?: (entity: Entity) => boolean;
}

function entityAt(viewer: Viewer, position: Cartesian2): Entity | undefined {
    const picked = viewer.scene.pick(position);
    return defined(picked) && picked.id instanceof Entity ? picked.id : undefined;
}

/** Map pointer input for one page or tool. While dragging, the camera stays still. */
export function useMapInput(active: boolean, input: MapInput): void {
    const viewer = useMap((s) => s.viewer);
    const ref = useRef(input);
    ref.current = input;

    useEffect(() => {
        if (!viewer || !active) return;
        const { scene } = viewer;
        const canvas = scene.canvas;
        const handler = new ScreenSpaceEventHandler(canvas);
        let dragging: Entity | null = null;
        let suppressClick = false;

        const setCursor = (hovered: Entity | undefined) => {
            const h = ref.current;
            canvas.style.cursor = dragging
                ? 'grabbing'
                : hovered && h.draggable?.(hovered)
                  ? 'grab'
                  : hovered && h.hoverable?.(hovered)
                    ? 'pointer'
                    : (h.cursor ?? '');
        };

        handler.setInputAction((e: ScreenSpaceEventHandler.PositionedEvent) => {
            const entity = entityAt(viewer, e.position);
            if (entity && ref.current.draggable?.(entity)) {
                dragging = entity;
                scene.screenSpaceCameraController.enableInputs = false;
                setCursor(entity);
            }
        }, ScreenSpaceEventType.LEFT_DOWN);

        handler.setInputAction((e: ScreenSpaceEventHandler.MotionEvent) => {
            if (dragging) {
                const point = pickPoint(viewer, e.endPosition);
                if (point) ref.current.onDrag?.(dragging, point);
                suppressClick = true;
                return;
            }
            const entity = entityAt(viewer, e.endPosition);
            ref.current.onMove?.(pickPoint(viewer, e.endPosition), entity, e.endPosition);
            setCursor(entity);
        }, ScreenSpaceEventType.MOUSE_MOVE);

        handler.setInputAction(() => {
            if (!dragging) return;
            const done = dragging;
            dragging = null;
            scene.screenSpaceCameraController.enableInputs = true;
            ref.current.onDragEnd?.(done);
            setCursor(done);
        }, ScreenSpaceEventType.LEFT_UP);

        handler.setInputAction((e: ScreenSpaceEventHandler.PositionedEvent) => {
            if (suppressClick) {
                suppressClick = false;
                return;
            }
            ref.current.onClick?.(pickPoint(viewer, e.position), entityAt(viewer, e.position));
        }, ScreenSpaceEventType.LEFT_CLICK);

        handler.setInputAction((e: ScreenSpaceEventHandler.PositionedEvent) => {
            ref.current.onDoubleClick?.(
                pickPoint(viewer, e.position),
                entityAt(viewer, e.position),
            );
        }, ScreenSpaceEventType.LEFT_DOUBLE_CLICK);

        handler.setInputAction((e: ScreenSpaceEventHandler.PositionedEvent) => {
            ref.current.onRightClick?.(pickPoint(viewer, e.position), entityAt(viewer, e.position));
        }, ScreenSpaceEventType.RIGHT_CLICK);

        const leave = () => ref.current.onLeave?.();
        canvas.addEventListener('pointerleave', leave);
        canvas.style.cursor = ref.current.cursor ?? '';
        return () => {
            handler.destroy();
            canvas.removeEventListener('pointerleave', leave);
            if (!viewer.isDestroyed()) {
                scene.screenSpaceCameraController.enableInputs = true;
                canvas.style.cursor = '';
            }
        };
    }, [viewer, active]);
}
