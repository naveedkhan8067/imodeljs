/*---------------------------------------------------------------------------------------------
* Copyright (c) 2019 Bentley Systems, Incorporated. All rights reserved.
* Licensed under the MIT License. See LICENSE.md in the project root for license terms.
*--------------------------------------------------------------------------------------------*/
/** @module Views */
import { BentleyStatus, BeEvent, BeUiEvent } from "@bentley/bentleyjs-core";
import { HitDetail } from "./HitDetail";
import { IModelApp } from "./IModelApp";
import { IModelConnection } from "./IModelConnection";
import { DrawingModelState, SectionDrawingModelState, SheetModelState, SpatialModelState } from "./ModelState";
import { EventController } from "./tools/EventController";
import { BeButtonEvent, EventHandled } from "./tools/Tool";
import { DecorateContext } from "./ViewContext";
import { ScreenViewport } from "./Viewport";
import { DrawingViewState, OrthographicViewState, SpatialViewState } from "./ViewState";
import { GeometryStreamProps } from "@bentley/imodeljs-common";
import { SheetViewState } from "./Sheet";

/** Interface for drawing "decorations" into, or on top of, the active [[Viewport]]s.
 * Decorators generate [[Decorations]].
 * @public
 */
export interface Decorator {
  /** Implement this method to add Decorations into the supplied DecorateContext. */
  decorate(context: DecorateContext): void;

  /** If the [[decorate]] method created pickable graphics, return true if the supplied Id is from this Decorator.
   * @param id The Id of the currently selected pickable graphics.
   * @returns true if 'id' belongs to this Decorator
   */
  testDecorationHit?(id: string): boolean;

  /** If [[testDecorationHit]] returned true, implement this method to return the tooltip message for this Decorator.
   * @param hit The HitDetail about the decoration that was picked.
   * @returns A promise with the HTMLElement or string (that may contain HTML) with the tooltip message.
   */
  getDecorationToolTip?(hit: HitDetail): Promise<HTMLElement | string>;

  /** If [[testDecorationHit]] returned true, implement this method to handle a button event for this Decorator.
   * @param hit The HitDetail about the decoration that was picked.
   * @param ev The BeButtonEvent that identified this decoration.
   * @returns  A Promise that resolves to Yes if event completely handled by decoration and event should not be processed by the calling tool.
   */
  onDecorationButtonEvent?(hit: HitDetail, ev: BeButtonEvent): Promise<EventHandled>;

  /** If [[testDecorationHit]] returned true, implement this method to return the snappable geometry for this Decorator. Geometry that changes with every cursor motion isn't valid for snapping.
   * An example would be an InteractiveTool for placing a linestring. It might wish to allow snapping to accepted segments, the segment from the last accepted point to the current cursor position would not be included
   * as snappable geometry and would just be displayed in dynamics.
   * @param hit The HitDetail about the decoration that was picked.
   * @returns GeometryStreamProps containing world coordinate snappable geometry for this decoration.
   */
  getDecorationGeometry?(hit: HitDetail): GeometryStreamProps | undefined;
}

/** Argument for [[ViewManager.onSelectedViewportChanged]] */
export interface SelectedViewportChangedArgs {
  current?: ScreenViewport;
  previous?: ScreenViewport;
}

/** The ViewManager holds the list of opened views, plus the *selected view*. It also provides notifications of view open/close and suspend/resume.
 * Applications must call [[addViewport]] when new Viewports that should be associated with user events are created.
 *
 * A single ViewManager is created when [[IModelApp.startup]] is called. It can be accessed via the static member [[IModelApp.viewManager]].
 *
 * The ViewManager controls the render loop, which causes the contents of each registered [[Viewport]] to update on the screen.
 * @public
 */
export class ViewManager {
  public inDynamicsMode = false;
  public cursor = "default";
  private readonly _viewports: ScreenViewport[] = [];
  public readonly decorators: Decorator[] = [];
  private _selectedView?: ScreenViewport;
  private _invalidateScenes = false;
  private _skipSceneCreation = false;

  /** @internal */
  public onInitialized() {
    IModelConnection.registerClass(SpatialModelState.getClassFullName(), SpatialModelState);
    IModelConnection.registerClass("BisCore:PhysicalModel", SpatialModelState);
    IModelConnection.registerClass("BisCore:SpatialLocationModel", SpatialModelState);
    IModelConnection.registerClass(DrawingModelState.getClassFullName(), DrawingModelState);
    IModelConnection.registerClass(SectionDrawingModelState.getClassFullName(), SectionDrawingModelState);
    IModelConnection.registerClass(SheetModelState.getClassFullName(), SheetModelState);
    IModelConnection.registerClass(OrthographicViewState.getClassFullName(), OrthographicViewState as any); // the "as any" is to get around problem with abstract base classes
    IModelConnection.registerClass(SpatialViewState.getClassFullName(), SpatialViewState as any);
    IModelConnection.registerClass(DrawingViewState.getClassFullName(), DrawingViewState as any);
    IModelConnection.registerClass(SheetViewState.getClassFullName(), SheetViewState as any);

    this.addDecorator(IModelApp.accuSnap);
    this.addDecorator(IModelApp.tentativePoint);
    this.addDecorator(IModelApp.accuDraw);
    this.addDecorator(IModelApp.toolAdmin);
    this.cursor = "default";
  }

  /** @internal */
  public onShutDown() {
    this._viewports.length = 0;
    this.decorators.length = 0;
    this._selectedView = undefined;
  }

  /** Called after the selected view changes.
   * @param old Previously selected viewport.
   * @param current Currently selected viewport.
   */
  public readonly onSelectedViewportChanged = new BeUiEvent<SelectedViewportChangedArgs>();

  /** Called after a view is opened. This can happen when the iModel is first opened or when a user opens a new view. */
  public readonly onViewOpen = new BeUiEvent<ScreenViewport>();

  /** Called after a view is closed. This can happen when the iModel is closed or when a user closes an open view. */
  public readonly onViewClose = new BeUiEvent<ScreenViewport>();

  /** Called after a view is suspended. This happens when the application is minimized or, on a tablet, when the application
   * is moved to the background.
   */
  public readonly onViewSuspend = new BeUiEvent<ScreenViewport>();

  /** Called after a suspended view is resumed. This can happen when a minimized application is restored
   * or, on a tablet, when the application is moved to the foreground.
   */
  public readonly onViewResume = new BeUiEvent<ScreenViewport>();

  /** Called at the beginning of each tick of the render loop, before any viewports have been updated.
   * The render loop is typically invoked by a requestAnimationFrame() callback. It will not be invoked if the ViewManager is tracking no viewports.
   * @note Due to the frequency of this event, avoid performing expensive work inside event listeners.
   * @see [[ViewManager.onFinishRender]]
   */
  public readonly onBeginRender = new BeEvent<() => void>();

  /** Called at the end of each tick of the render loop, after all viewports have been updated.
   * The render loop is typically invoked by a requestAnimationFrame() callback. It will not be invoked if the ViewManager is tracking no viewports.
   * @note Due to the frequency of this event, avoid performing expensive work inside event listeners.
   * @see [[ViewManager.onBeginRender]]
   */
  public readonly onFinishRender = new BeEvent<() => void>();

  /** @internal */
  public endDynamicsMode(): void {
    if (!this.inDynamicsMode)
      return;

    this.inDynamicsMode = false;

    const cursorVp = IModelApp.toolAdmin.cursorView;
    if (cursorVp)
      cursorVp.changeDynamics(undefined);

    for (const vp of this._viewports) {
      if (vp !== cursorVp)
        vp.changeDynamics(undefined);
    }
  }

  /** @internal */
  public beginDynamicsMode() { this.inDynamicsMode = true; }

  /** @internal */
  public get doesHostHaveFocus(): boolean { return document.hasFocus(); }

  /** Set the selected [[Viewport]] to undefined. */
  public clearSelectedView(): void {
    const previousVp = this.selectedView;
    this._selectedView = undefined;
    this.notifySelectedViewportChanged(previousVp, undefined);
  }

  /** Sets the selected [[Viewport]]. */
  public setSelectedView(vp: ScreenViewport | undefined): BentleyStatus {
    if (undefined === vp)
      vp = this.getFirstOpenView();

    if (vp === this.selectedView) // already the selected view
      return BentleyStatus.SUCCESS;

    if (undefined === vp) {
      this.clearSelectedView();
      return BentleyStatus.ERROR;
    }

    const previousVp = this.selectedView;
    this._selectedView = vp;

    this.notifySelectedViewportChanged(previousVp, vp);

    if (undefined === previousVp)
      IModelApp.toolAdmin.startDefaultTool();

    return BentleyStatus.SUCCESS;
  }

  /** @internal */
  public notifySelectedViewportChanged(previous: ScreenViewport | undefined, current: ScreenViewport | undefined): void {
    IModelApp.toolAdmin.onSelectedViewportChanged(previous, current);
    this.onSelectedViewportChanged.emit({ previous, current });
  }

  /** The "selected view" is the default for certain operations.  */
  public get selectedView(): ScreenViewport | undefined { return this._selectedView; }

  /** Get the first opened view. */
  public getFirstOpenView(): ScreenViewport | undefined { return this._viewports.length > 0 ? this._viewports[0] : undefined; }

  /** Add a new Viewport to the list of opened views and create an EventController for it.
   * @param newVp the Viewport to add
   * @returns SUCCESS if vp was successfully added, ERROR if it was already present.
   * @note raises onViewOpen event with newVp.
   */
  public addViewport(newVp: ScreenViewport): BentleyStatus {
    if (this._viewports.includes(newVp)) // make sure its not already added
      return BentleyStatus.ERROR;

    newVp.setEventController(new EventController(newVp)); // this will direct events to the viewport
    this._viewports.push(newVp);

    this.setSelectedView(newVp);

    // Start up the render loop if necessary.
    if (1 === this._viewports.length)
      IModelApp.toolAdmin.startEventLoop();

    this.onViewOpen.emit(newVp);

    return BentleyStatus.SUCCESS;
  }

  /** Remove a Viewport from the list of opened views, and optionally dispose of it.
   * Typically a Viewport is dropped when it is no longer of any use to the application, in which case it should also be
   * disposed of as it may hold significant GPU resources.
   * However in some cases a Viewport may be temporarily dropped to suspend rendering; and subsequently re-added to
   * resume rendering - for example, when the Viewport is temporarily hidden by other UI elements.
   * In the latter case it is up to the caller to ensure the Viewport is properly disposed of when it is no longer needed.
   * Attempting to invoke any function on a Viewport after it has been disposed is an error.
   * @param vp the Viewport to remove.
   * @param disposeOfViewport Whether or not to dispose of the Viewport. Defaults to true.
   * @return SUCCESS if vp was successfully removed, ERROR if it was not present.
   * @note raises onViewClose event with vp.
   */
  public dropViewport(vp: ScreenViewport, disposeOfViewport: boolean = true): BentleyStatus {
    const index = this._viewports.indexOf(vp);
    if (index === -1)
      return BentleyStatus.ERROR;

    this.onViewClose.emit(vp);

    // make sure tools don't think the cursor is still in this viewport
    IModelApp.toolAdmin.onMouseLeave(vp); // tslint:disable-line:no-floating-promises

    vp.setEventController(undefined);
    this._viewports.splice(index, 1);

    if (this.selectedView === vp) // if removed viewport was selectedView, set it to undefined.
      this.setSelectedView(undefined);

    if (disposeOfViewport)
      vp.dispose();

    return BentleyStatus.SUCCESS;
  }

  /** Call the specified function on each [[Viewport]] registered with the ViewManager. */
  public forEachViewport(func: (vp: ScreenViewport) => void) { this._viewports.forEach((vp) => func(vp)); }

  /** Force each registered [[Viewport]] to regenerate its [[Decorations]] on the next frame. */
  public invalidateDecorationsAllViews(): void { this.forEachViewport((vp) => vp.invalidateDecorations()); }
  /** @internal */
  public onSelectionSetChanged(_iModel: IModelConnection) { this.forEachViewport((vp) => vp.view.setSelectionSetDirty()); }
  /** @internal */
  public invalidateViewportScenes(): void { this.forEachViewport((vp) => vp.sync.invalidateScene()); }
  /** @internal */
  public validateViewportScenes(): void { this.forEachViewport((vp) => vp.sync.setValidScene()); }

  /** @internal */
  public invalidateScenes(): void { this._invalidateScenes = true; }
  /** @internal */
  public get sceneInvalidated(): boolean { return this._invalidateScenes; }
  /** @internal */
  public onNewTilesReady(): void { this.invalidateScenes(); }

  /** Invoked by ToolAdmin event loop.
   * @internal
   */
  public renderLoop(): void {
    if (0 === this._viewports.length) return;
    if (this._skipSceneCreation)
      this.validateViewportScenes();
    else if (this._invalidateScenes)
      this.invalidateViewportScenes();

    this._invalidateScenes = false;

    const cursorVp = IModelApp.toolAdmin.cursorView;

    this.onBeginRender.raiseEvent();

    if (undefined === cursorVp || cursorVp.renderFrame())
      for (const vp of this._viewports)
        if (vp !== cursorVp && !vp.renderFrame())
          break;

    this.onFinishRender.raiseEvent();
  }

  /** Add a new [[Decorator]] to display decorations into the active views.
   * @param decorator The new decorator to add.
   * @throws Error if decorator is already active.
   * @returns a function that may be called to remove this decorator (in lieu of calling [[dropDecorator]].)
   * @see [[dropDecorator]]
   */
  public addDecorator(decorator: Decorator): () => void {
    if (this.decorators.includes(decorator))
      throw new Error("decorator already registered");

    this.decorators.push(decorator);
    this.invalidateDecorationsAllViews();
    return () => { this.dropDecorator(decorator); };
  }

  /** Drop (remove) a [[Decorator]] so it is no longer active.
   * @param decorator The Decorator to drop.
   * @note Does nothing if decorator is not currently active.
   */
  public dropDecorator(decorator: Decorator) {
    const index = this.decorators.indexOf(decorator);
    if (index >= 0)
      this.decorators.splice(index, 1);
    this.invalidateDecorationsAllViews();
  }

  /** Get the tooltip for a pickable decoration.
   * @internal
   */
  public async getDecorationToolTip(hit: HitDetail): Promise<HTMLElement | string> {
    for (const decorator of this.decorators) {
      if (undefined !== decorator.testDecorationHit && undefined !== decorator.getDecorationToolTip && decorator.testDecorationHit(hit.sourceId))
        return decorator.getDecorationToolTip(hit);
    }
    return "";
  }

  /** Allow a pickable decoration to handle a button event that identified it for the SelectTool.
   * @internal
   */
  public async onDecorationButtonEvent(hit: HitDetail, ev: BeButtonEvent): Promise<EventHandled> {
    for (const decorator of IModelApp.viewManager.decorators) {
      if (undefined !== decorator.testDecorationHit && undefined !== decorator.onDecorationButtonEvent && decorator.testDecorationHit(hit.sourceId))
        return decorator.onDecorationButtonEvent(hit, ev);
    }
    return EventHandled.No;
  }

  /** Allow a pickable decoration to be snapped to by AccuSnap or TentativePoint.
   * @internal
   */
  public getDecorationGeometry(hit: HitDetail): GeometryStreamProps | undefined {
    for (const decorator of IModelApp.viewManager.decorators) {
      if (undefined !== decorator.testDecorationHit && undefined !== decorator.getDecorationGeometry && decorator.testDecorationHit(hit.sourceId))
        return decorator.getDecorationGeometry(hit);
    }
    return undefined;
  }

  public get crossHairCursor(): string { return "url(cursors/crosshair.cur), crosshair"; }
  public get dynamicsCursor(): string { return "url(cursors/dynamics.cur), move"; }
  public get grabCursor(): string { return "url(cursors/openHand.cur), auto"; }
  public get grabbingCursor(): string { return "url(cursors/closedHand.cur), auto"; }

  /** Change the cursor shown in all Viewports.
   * @param cursor The new cursor to display. If undefined, the default cursor is used.
   */
  public setViewCursor(cursor: string = "default") {
    if (cursor === this.cursor)
      return;

    this.cursor = cursor;
    if (undefined !== this.selectedView) {
      this.selectedView.setCursor(cursor);
    }
  }
}
