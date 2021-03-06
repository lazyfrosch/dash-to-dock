// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-

const Clutter = imports.gi.Clutter;
const Lang = imports.lang;
const Meta = imports.gi.Meta;
const Signals = imports.signals;
const St = imports.gi.St;
const Shell = imports.gi.Shell;
const Mainloop = imports.mainloop;

const AppDisplay = imports.ui.appDisplay;
const AppFavorites = imports.ui.appFavorites;
const Dash = imports.ui.dash;
const DND = imports.ui.dnd;
const Main = imports.ui.main;
const Overview = imports.ui.overview;
const Tweener = imports.ui.tweener;

const Me = imports.misc.extensionUtils.getCurrentExtension();
const Convenience = Me.imports.convenience;

let DASH_ITEM_HOVER_TIMEOUT = Dash.DASH_ITEM_HOVER_TIMEOUT;
let DASH_ANIMATION_TIME = Dash.DASH_ANIMATION_TIME;

/* This class is a fork of the upstream dash class (ui.dash.js)
 *
 * Summary of changes:
 * - disconnect global signals adding a destroy method;
 * - play animations even when not in overview mode
 * - set a maximum icon size
 * - show running and/or favorite applications
 * - emit a custom signal when an app icon is added
 *
 */
const myDash = new Lang.Class({
    Name: 'dashToDock.myDash',

    _init : function(settings) {
        this._maxHeight = -1;
        this.iconSize = 64;
        this._allIconSize = [ 16, 22, 24, 32, 48, 64 ];
        this._avaiableIconSize = this._allIconSize;
        this._shownInitially = false;

        this._settings = settings;
        this._signalHandler = new Convenience.globalSignalHandler();

        this._dragPlaceholder = null;
        this._dragPlaceholderPos = -1;
        this._animatingPlaceholdersCount = 0;
        this._favRemoveTarget = null;
        this._showLabelTimeoutId = 0;
        this._resetHoverTimeoutId = 0;
        this._labelShowing = false;

        this._box = new St.BoxLayout({ name: 'dash',
                                       vertical: true,
                                       clip_to_allocation: true });
        this._box._delegate = this;

        this.actor = new St.Bin({ y_align: St.Align.START, child: this._box });
        this.actor.connect('notify::height', Lang.bind(this,
            function() {
                if (this._maxHeight != this.actor.height)
                    this._queueRedisplay();
                this._maxHeight = this.actor.height;
            }));

        this._workId = Main.initializeDeferredWork(this._box, Lang.bind(this, this._redisplay));

        this._tracker = Shell.WindowTracker.get_default();
        this._appSystem = Shell.AppSystem.get_default();

        this._appSystem.connect('installed-changed', Lang.bind(this, this._queueRedisplay));
        AppFavorites.getAppFavorites().connect('changed', Lang.bind(this, this._queueRedisplay));
        this._appSystem.connect('app-state-changed', Lang.bind(this, this._queueRedisplay));

        this._signalHandler.push(
            [
                Main.overview,
                'item-drag-begin',
                Lang.bind(this, this._onDragBegin)
            ],
            [
                Main.overview,
                'item-drag-end',
                Lang.bind(this, this._onDragEnd)
            ],
            [
                Main.overview,
                'item-drag-cancelled',
                Lang.bind(this, this._onDragCancelled)
            ],
            [
                Main.overview,
                'window-drag-begin',
                Lang.bind(this, this._onDragBegin)
            ],
            [
                Main.overview,
                'window-drag-cancelled',
                Lang.bind(this, this._onDragCancelled)
            ],
            [
                Main.overview,
                'window-drag-end',
                Lang.bind(this, this._onDragEnd)
            ]
        );

        this.setMaxIconSize(this._settings.get_int('dash-max-icon-size'));

    },

    destroy: function() {
        this._signalHandler.disconnect();
    },

    _onDragBegin: function() {
        this._dragCancelled = false;
        this._dragMonitor = {
            dragMotion: Lang.bind(this, this._onDragMotion)
        };
        DND.addDragMonitor(this._dragMonitor);
    },

    _onDragCancelled: function() {
        this._dragCancelled = true;
        this._endDrag();
    },

    _onDragEnd: function() {
        if (this._dragCancelled)
            return;

        this._endDrag();
    },

    _endDrag: function() {
        this._clearDragPlaceholder();
        if (this._favRemoveTarget) {
            this._favRemoveTarget.animateOutAndDestroy();
            this._favRemoveTarget.actor.connect('destroy', Lang.bind(this,
                function() {
                    this._favRemoveTarget = null;
                }));
            this._adjustIconSize();
        }
        DND.removeDragMonitor(this._dragMonitor);
    },

    _onDragMotion: function(dragEvent) {
        let app = null;
        if (dragEvent.source instanceof AppDisplay.AppWellIcon)
            app = this._appSystem.lookup_app(dragEvent.source.getId());
        else if (dragEvent.source.metaWindow)
            app = this._tracker.get_window_app(dragEvent.source.metaWindow);
        else
            return DND.DragMotionResult.CONTINUE;

        let id = app.get_id();

        let favorites = AppFavorites.getAppFavorites().getFavoriteMap();

        let srcIsFavorite = (id in favorites);

        if (srcIsFavorite &&
            app.get_state() != Shell.AppState.RUNNING &&
            dragEvent.source.actor &&
            this.actor.contains (dragEvent.source.actor) &&
            this._favRemoveTarget == null) {
                this._favRemoveTarget = new Dash.RemoveFavoriteIcon();
                this._favRemoveTarget.icon.setIconSize(this.iconSize);
                this._box.add(this._favRemoveTarget.actor);
                this._adjustIconSize();
                this._favRemoveTarget.animateIn();
        }

        let favRemoveHovered = false;
        if (this._favRemoveTarget)
            favRemoveHovered =
                this._favRemoveTarget.actor.contains(dragEvent.targetActor);

        if (!this._box.contains(dragEvent.targetActor) || favRemoveHovered)
            this._clearDragPlaceholder();

        if (this._favRemoveTarget)
            this._favRemoveTarget.setHover(favRemoveHovered);

        return DND.DragMotionResult.CONTINUE;
    },

    _appIdListToHash: function(apps) {
        let ids = {};
        for (let i = 0; i < apps.length; i++)
            ids[apps[i].get_id()] = apps[i];
        return ids;
    },

    _queueRedisplay: function () {
        Main.queueDeferredWork(this._workId);
    },

    _createAppItem: function(app) {
        let display = new myAppWellIcon(this._settings, this, app,
                                                 { setSizeManually: true,
                                                   showLabel: false });
        display._draggable.connect('drag-begin',
                                   Lang.bind(this, function() {
                                       display.actor.opacity = 50;
                                   }));
        display._draggable.connect('drag-end',
                                   Lang.bind(this, function() {
                                       display.actor.opacity = 255;
                                   }));

        let item = new Dash.DashItemContainer();
        item.setChild(display.actor);

        item.setLabelText(app.get_name());
        // Override default AppWellIcon label_actor
        display.actor.label_actor = item.label;


        display.icon.setIconSize(this.iconSize);
        display.actor.connect('notify::hover',
                               Lang.bind(this, function() {
                                   this._onHover(item, display)
                               }));
        return item;
    },

    _onHover: function (item, display) {
        if (display.actor.get_hover() && !display.isMenuUp) {
            if (this._showLabelTimeoutId == 0) {
                let timeout = this._labelShowing ? 0 : DASH_ITEM_HOVER_TIMEOUT;
                this._showLabelTimeoutId = Mainloop.timeout_add(timeout,
                    Lang.bind(this, function() {
                        this._labelShowing = true;
                        item.showLabel();
                        return false;
                    }));
                if (this._resetHoverTimeoutId > 0) {
                    Mainloop.source_remove(this._resetHoverTimeoutId);
                this._resetHoverTimeoutId = 0;
                }
            }
        } else {
            if (this._showLabelTimeoutId > 0)
                Mainloop.source_remove(this._showLabelTimeoutId);
            this._showLabelTimeoutId = 0;
            item.hideLabel();
            if (this._labelShowing) {
                this._resetHoverTimeoutId = Mainloop.timeout_add(DASH_ITEM_HOVER_TIMEOUT,
                    Lang.bind(this, function() {
                        this._labelShowing = false;
                        return false;
                    }));
            }
        }
    },

    _adjustIconSize: function() {
        // For the icon size, we only consider children which are "proper"
        // icons (i.e. ignoring drag placeholders) and which are not
        // animating out (which means they will be destroyed at the end of
        // the animation)
        let iconChildren = this._box.get_children().filter(function(actor) {
            return actor._delegate.child &&
                   actor._delegate.child._delegate &&
                   actor._delegate.child._delegate.icon &&
                   !actor._delegate.animatingOut;
        });

        if (iconChildren.length == 0) {
            this._box.add_style_pseudo_class('empty');
            return;
        }

        this._box.remove_style_pseudo_class('empty');

        if (this._maxHeight == -1)
            return;

        // Prevent shell crash if the actor is not on the stage.
        // It happens enabling/disabling repeatedly the extension
        if(!this._box.get_stage())
            return;

        let themeNode = this._box.get_theme_node();
        let maxAllocation = new Clutter.ActorBox({ x1: 0, y1: 0,
                                                   x2: 42 /* whatever */,
                                                   y2: this._maxHeight });
        let maxContent = themeNode.get_content_box(maxAllocation);
        let availHeight = maxContent.y2 - maxContent.y1;
        let spacing = themeNode.get_length('spacing');


        let firstIcon = iconChildren[0]._delegate.child._delegate.icon;

        let minHeight, natHeight;

        // Enforce the current icon size during the size request if
        // the icon is animating
        if (firstIcon._animating) {
            let [currentWidth, currentHeight] = firstIcon.icon.get_size();

            firstIcon.icon.set_size(this.iconSize, this.iconSize);
            [minHeight, natHeight] = iconChildren[0].get_preferred_height(-1);

            firstIcon.icon.set_size(currentWidth, currentHeight);
        } else {
            [minHeight, natHeight] = iconChildren[0].get_preferred_height(-1);
        }


        // Subtract icon padding and box spacing from the available height
        availHeight -= iconChildren.length * (natHeight - this.iconSize) +
                       (iconChildren.length - 1) * spacing;

        let availSize = availHeight / iconChildren.length;

        let iconSizes = this._avaiableIconSize;

        let newIconSize = 16;
        for (let i = 0; i < iconSizes.length; i++) {
            if (iconSizes[i] < availSize)
                newIconSize = iconSizes[i];
        }

        if (newIconSize == this.iconSize)
            return;

        let oldIconSize = this.iconSize;
        this.iconSize = newIconSize;
        this.emit('icon-size-changed');

        let scale = oldIconSize / newIconSize;
        for (let i = 0; i < iconChildren.length; i++) {
            let icon = iconChildren[i]._delegate.child._delegate.icon;

            // Set the new size immediately, to keep the icons' sizes
            // in sync with this.iconSize
            icon.setIconSize(this.iconSize);

            // Don't animate when initially filling the dash
            if (!this._shownInitially)
                continue;

            let [targetWidth, targetHeight] = icon.icon.get_size();

            // Scale the icon's texture to the previous size and
            // tween to the new size
            icon.icon.set_size(icon.icon.width * scale,
                               icon.icon.height * scale);

            icon._animating = true;
            Tweener.addTween(icon.icon,
                             { width: targetWidth,
                               height: targetHeight,
                               time: DASH_ANIMATION_TIME,
                               transition: 'easeOutQuad',
                               onComplete: function() {
                                   icon._animating = false;
                               }
                             });
        }
    },

    _redisplay: function () {
        let favorites = AppFavorites.getAppFavorites().getFavoriteMap();

        let running = this._appSystem.get_running();

        let children = this._box.get_children().filter(function(actor) {
                return actor._delegate.child &&
                       actor._delegate.child._delegate &&
                       actor._delegate.child._delegate.app;
            });
        // Apps currently in the dash
        let oldApps = children.map(function(actor) {
                return actor._delegate.child._delegate.app;
            });
        // Apps supposed to be in the dash
        let newApps = [];

        if( this._settings.get_boolean('show-favorites') ) {
            for (let id in favorites)
                newApps.push(favorites[id]);
        }

        if( this._settings.get_boolean('show-running') ) {
            for (let i = 0; i < running.length; i++) {
                let app = running[i];
                if (this._settings.get_boolean('show-favorites') && (app.get_id() in favorites) )
                    continue;
                newApps.push(app);
            }
        }

        // Figure out the actual changes to the list of items; we iterate
        // over both the list of items currently in the dash and the list
        // of items expected there, and collect additions and removals.
        // Moves are both an addition and a removal, where the order of
        // the operations depends on whether we encounter the position
        // where the item has been added first or the one from where it
        // was removed.
        // There is an assumption that only one item is moved at a given
        // time; when moving several items at once, everything will still
        // end up at the right position, but there might be additional
        // additions/removals (e.g. it might remove all the launchers
        // and add them back in the new order even if a smaller set of
        // additions and removals is possible).
        // If above assumptions turns out to be a problem, we might need
        // to use a more sophisticated algorithm, e.g. Longest Common
        // Subsequence as used by diff.
        let addedItems = [];
        let removedActors = [];

        let newIndex = 0;
        let oldIndex = 0;
        while (newIndex < newApps.length || oldIndex < oldApps.length) {
            // No change at oldIndex/newIndex
            if (oldApps[oldIndex] == newApps[newIndex]) {
                oldIndex++;
                newIndex++;
                continue;
            }

            // App removed at oldIndex
            if (oldApps[oldIndex] &&
                newApps.indexOf(oldApps[oldIndex]) == -1) {
                removedActors.push(children[oldIndex]);
                oldIndex++;
                continue;
            }

            // App added at newIndex
            if (newApps[newIndex] &&
                oldApps.indexOf(newApps[newIndex]) == -1) {
                addedItems.push({ app: newApps[newIndex],
                                  item: this._createAppItem(newApps[newIndex]),
                                  pos: newIndex });
                newIndex++;
                continue;
            }

            // App moved
            let insertHere = newApps[newIndex + 1] &&
                             newApps[newIndex + 1] == oldApps[oldIndex];
            let alreadyRemoved = removedActors.reduce(function(result, actor) {
                let removedApp = actor._delegate.child._delegate.app;
                return result || removedApp == newApps[newIndex];
            }, false);

            if (insertHere || alreadyRemoved) {
                let newItem = this._createAppItem(newApps[newIndex]);
                addedItems.push({ app: newApps[newIndex],
                                  item: newItem,
                                  pos: newIndex + removedActors.length });
                newIndex++;
            } else {
                removedActors.push(children[oldIndex]);
                oldIndex++;
            }
        }

        for (let i = 0; i < addedItems.length; i++)
            this._box.insert_child_at_index(addedItems[i].item.actor,
                                            addedItems[i].pos);

        for (let i = 0; i < removedActors.length; i++) {
            let item = removedActors[i]._delegate;
            item.animateOutAndDestroy();
        }

        this._adjustIconSize();

        for (let i = 0; i < addedItems.length; i++){
            // Emit a custom signal notifying that a new item has been added
            this.emit('item-added', addedItems[i]);
        }

        // Skip animations on first run when adding the initial set
        // of items, to avoid all items zooming in at once
        if (!this._shownInitially) {
            this._shownInitially = true;
            return;
        }

        for (let i = 0; i < addedItems.length; i++)
            addedItems[i].item.animateIn();
    },

    setMaxIconSize: function(size) {

        if( size>=this._allIconSize[0] ){

            this._avaiableIconSize = this._allIconSize.filter(
                function(val){
                    return (val<=size);
                }
            );

        } else {
            this._availableIconSize = [ this._allIconSize[0] ];
        }

        // Changing too rapidly icon size settings cause the whole Shell to freeze
        // I've not discovered exactly why, but disabling animation by setting
        // shownInitially prevent the freeze from occuring
        this._shownInitially = false;

        this._redisplay();

    },

    // Reset the displayed apps icon to mantain the correct order when changing
    // show favorites/show running settings
    resetAppIcons : function() {

        let children = this._box.get_children().filter(function(actor) {
            return actor._delegate.child &&
                   actor._delegate.child._delegate &&
                   actor._delegate.child._delegate.app;
        });
        for (let i = 0; i < children.length; i++) {
            let item = children[i]._delegate;
            item.actor.destroy();
        }

        // to avoid ugly animations, just suppress them like when dash is first loaded.
        this._shownInitially = false;
        this._redisplay();

    },

    _clearDragPlaceholder: function() {
        if (this._dragPlaceholder) {
            this._dragPlaceholder.animateOutAndDestroy();
            this._dragPlaceholder = null;
            this._dragPlaceholderPos = -1;
        }
    },

    handleDragOver : function(source, actor, x, y, time) {

        // Don't allow to add favourites if they are not displayed
        if( !this._settings.get_boolean('show-favorites') )
            return DND.DragMotionResult.NO_DROP;

        let app = null;
        if (source instanceof AppDisplay.AppWellIcon)
            app = this._appSystem.lookup_app(source.getId());
        else if (source.metaWindow)
            app = this._tracker.get_window_app(source.metaWindow);

        // Don't allow favoriting of transient apps
        if (app == null || app.is_window_backed())
            return DND.DragMotionResult.NO_DROP;

        let favorites = AppFavorites.getAppFavorites().getFavorites();
        let numFavorites = favorites.length;

        let favPos = favorites.indexOf(app);

        let children = this._box.get_children();
        let numChildren = children.length;
        let boxHeight = this._box.height;

        // Keep the placeholder out of the index calculation; assuming that
        // the remove target has the same size as "normal" items, we don't
        // need to do the same adjustment there.
        if (this._dragPlaceholder) {
            boxHeight -= this._dragPlaceholder.actor.height;
            numChildren--;
        }

        let pos = Math.floor(y * numChildren / boxHeight);

        if (pos != this._dragPlaceholderPos && pos <= numFavorites && this._animatingPlaceholdersCount == 0) {
            this._dragPlaceholderPos = pos;

            // Don't allow positioning before or after self
            if (favPos != -1 && (pos == favPos || pos == favPos + 1)) {
                if (this._dragPlaceholder) {
                    this._dragPlaceholder.animateOutAndDestroy();
                    this._animatingPlaceholdersCount++;
                    this._dragPlaceholder.actor.connect('destroy',
                        Lang.bind(this, function() {
                            this._animatingPlaceholdersCount--;
                        }));
                }
                this._dragPlaceholder = null;

                return DND.DragMotionResult.CONTINUE;
            }

            // If the placeholder already exists, we just move
            // it, but if we are adding it, expand its size in
            // an animation
            let fadeIn;
            if (this._dragPlaceholder) {
                this._dragPlaceholder.actor.destroy();
                fadeIn = false;
            } else {
                fadeIn = true;
            }

            this._dragPlaceholder = new Dash.DragPlaceholderItem();
            this._dragPlaceholder.child.set_width (this.iconSize);
            this._dragPlaceholder.child.set_height (this.iconSize / 2);
            this._box.insert_child_at_index(this._dragPlaceholder.actor,
                                            this._dragPlaceholderPos);
            if (fadeIn)
                this._dragPlaceholder.animateIn();
        }

        // Remove the drag placeholder if we are not in the
        // "favorites zone"
        if (pos > numFavorites && this._dragPlaceholder) {
            this._clearDragPlaceholder();
        }
        if (!this._dragPlaceholder)
            return DND.DragMotionResult.NO_DROP;

        let srcIsFavorite = (favPos != -1);

        if (srcIsFavorite)
            return DND.DragMotionResult.MOVE_DROP;

        return DND.DragMotionResult.COPY_DROP;
    },

    // Draggable target interface
    acceptDrop : function(source, actor, x, y, time) {

        // Don't allow to add favourites if they are not displayed
        if( !this._settings.get_boolean('show-favorites') )
            return true;

        let app = null;
        if (source instanceof AppDisplay.AppWellIcon) {
            app = this._appSystem.lookup_app(source.getId());
        } else if (source.metaWindow) {
            app = this._tracker.get_window_app(source.metaWindow);
        }

        // Don't allow favoriting of transient apps
        if (app == null || app.is_window_backed()) {
            return false;
        }

        let id = app.get_id();

        let favorites = AppFavorites.getAppFavorites().getFavoriteMap();

        let srcIsFavorite = (id in favorites);

        let favPos = 0;
        let children = this._box.get_children();
        for (let i = 0; i < this._dragPlaceholderPos; i++) {
            if (this._dragPlaceholder &&
                children[i] == this._dragPlaceholder.actor)
                continue;

            let childId = children[i]._delegate.child._delegate.app.get_id();
            if (childId == id)
                continue;
            if (childId in favorites)
                favPos++;
        }

        // No drag placeholder means we don't wan't to favorite the app
        // and we are dragging it to its original position
        if (!this._dragPlaceholder)
            return true;

        Meta.later_add(Meta.LaterType.BEFORE_REDRAW, Lang.bind(this,
            function () {
                let appFavorites = AppFavorites.getAppFavorites();
                if (srcIsFavorite)
                    appFavorites.moveFavoriteToPos(id, favPos);
                else
                    appFavorites.addFavoriteAtPos(id, favPos);
                return false;
            }));

        return true;
    }
});

Signals.addSignalMethods(myDash.prototype);


/**
 * Extend AppWellIcon
 *
 * - emit "menu-closed" signal on popup menu close.
 * - Pass settings to the constructor and bind settings changes
 * - Apply a css class based on the number of windows of each application (#N);
 *   a class of the form "running#N" is applied to the AppWellIcon actor.
 *   like the original .running one.
 * - add a .focused style to the focused app
 * - Customize click actions.
 *
 */

let tracker = Shell.WindowTracker.get_default();

const clickAction = {
    SKIP: 0,
    MINIMIZE: 1,
    LAUNCH: 2,
    CYCLE_WINDOWS: 3
};

let recentlyClickedAppLoopId = 0;
let recentlyClickedApp = null;
let recentlyClickedAppWindows = null;
let recentlyClickedAppIndex = 0;

const myAppWellIcon = new Lang.Class({
    Name: 'dashToDock.AppWellIcon',
    Extends: AppDisplay.AppWellIcon,

    // a good parent object is needed to emit the 'menu-closed' signal
    // settings are also required inside.
    _init: function(settings, parentObject, app, iconParams, onActivateOverride) {

        this._settings = settings;
        this._maxN =4;

        this.parent(app, iconParams, onActivateOverride);

        // Emit a custom signal when a menu is closed
        let _onMenuOpenStateOriginal = this._menuManager._onMenuOpenState;
        this._menuManager._onMenuOpenState = function(menu, open){
            if(!open)
                parentObject.emit('menu-closed');
            Lang.bind(this, _onMenuOpenStateOriginal)(menu, open);
        };

        // Monitor windows-changes instead of app state.
        // Keep using the same Id and function callback (that is extended)
        if(this._stateChangedId>0){
            this.app.disconnect(this._stateChangedId);
            this._stateChangedId=0;
        }

        this._stateChangedId = this.app.connect('windows-changed',
                                                Lang.bind(this,
                                                          this._onStateChanged));
        this._focuseAppChangeId = tracker.connect('notify::focus-app',
                                                Lang.bind(this,
                                                          this._onFocusAppChanged));

    },

    _onDestroy: function() {
        this.parent();

        // Disconect global signals
        // stateChangedId is already handled by parent)
        if(this._focusAppId>0)
            tracker.disconnect(this._focusAppId);
    },

    _onStateChanged: function() {

        this.parent();
        this._updateCounterClass();
    },

    _onFocusAppChanged: function() {
        if(tracker.focus_app == this.app)
            this.actor.add_style_class_name('focused');
        else
            this.actor.remove_style_class_name('focused');
    },

    _onActivate: function(event) {

        if ( !this._settings.get_boolean('customize-click') ){
            this.parent(event);
            return;
        }

        let modifiers = event.get_state();
        let focusedApp = tracker.focus_app;

        if(this.app.state == Shell.AppState.RUNNING) {

            if(modifiers & Clutter.ModifierType.CONTROL_MASK){
                // Keep default behaviour: launch new window
                this.emit('launching');
                this.app.open_new_window(-1);

            } else if (this._settings.get_boolean('minimize-shift') && modifiers & Clutter.ModifierType.SHIFT_MASK){
                // On double click, minimize all windows in the current workspace
                minimizeWindow(this.app, event.get_click_count() > 1);

            } else if(this.app == focusedApp && !Main.overview._shown){

                if(this._settings.get_enum('click-action') == clickAction.CYCLE_WINDOWS){
                    this.emit('launching');
                    cycleThroughWindows(this.app);

                } else if(this._settings.get_enum('click-action') == clickAction.MINIMIZE)
                    minimizeWindow(this.app, true);

                else if(this._settings.get_enum('click-action') == clickAction.LAUNCH){
                    this.emit('launching');
                    this.app.open_new_window(-1);
                }

            } else {
                // Activate all window of the app or only le last used
                this.emit('launching');
                if (this._settings.get_enum('click-action') == clickAction.CYCLE_WINDOWS && !Main.overview._shown){
                    // If click cycles through windows I can activate one windows at a time
                    let windows = this.app.get_windows();
                    let w = windows[0];
                    Main.activateWindow(w);
                } else if(this._settings.get_enum('click-action') == clickAction.LAUNCH)
                    this.app.open_new_window(-1);
                else if(this._settings.get_enum('click-action') == clickAction.MINIMIZE){
                    // If click minimizes all, then one expects all windows to be reshown
                    activateAllWindows(this.app);
                } else
                    this.app.activate();
            }
        } else {
            // Just launch new app
            this.emit('launching');
            this.app.activate();
        }

        Main.overview.hide();
    },

    _updateCounterClass: function() {

        let n = this.app.get_n_windows();
        if(n>this._maxN)
             n = this._maxN;

        for(let i = 1; i<=this._maxN; i++){
            let className = 'running'+i;
            if(i!=n)
                this.actor.remove_style_class_name(className);
            else
                this.actor.add_style_class_name(className);
        }
    }
});

function minimizeWindow(app, param){
    // Param true make all app windows minimize
    let windows = app.get_windows();
    let current_workspace = global.screen.get_active_workspace();
    for (let i = 0; i < windows.length; i++) {
        let w = windows[i];
        if (w.get_workspace() == current_workspace && w.showing_on_its_workspace()){
            w.minimize();
            // Just minimize one window. By specification it should be the
            // focused window on the current workspace.
            if(!param)
                break;
        }
    }
}

/*
 * By default only non minimized windows are activated.
 * This activates all windows in the current workspace.
 */
function activateAllWindows(app){

    // First activate first window so workspace is switched if needed.
    app.activate();

    // then activate all other app windows in the current workspace
    let windows = app.get_windows();
    let activeWorkspace = global.screen.get_active_workspace_index();

    if( windows.length<=0)
        return;

    let activatedWindows = 0;

    for (let i=windows.length-1; i>=0; i--){
        if(windows[i].get_workspace().index() == activeWorkspace){
            Main.activateWindow(windows[i]);
            activatedWindows++;
        }
    }
}

function cycleThroughWindows(app) {

    // Store for a little amount of time last clicked app and its windows
    // since the order changes upon window interaction
    let MEMORY_TIME=3000;

    if(recentlyClickedAppLoopId>0)
        Mainloop.source_remove(recentlyClickedAppLoopId);
    recentlyClickedAppLoopId = Mainloop.timeout_add(MEMORY_TIME, resetRecentlyClickedApp);

    // If there isn't already a list of windows for the current app,
    // or the stored list is outdated, use the current windows list.
    if( !recentlyClickedApp ||
        recentlyClickedApp.get_id() != app.get_id() ||
        recentlyClickedAppWindows.length != app.get_windows().length
      ){

        recentlyClickedApp = app;
        recentlyClickedAppWindows = app.get_windows();
        recentlyClickedAppIndex = 0;
    }

    recentlyClickedAppIndex++;
    let index = recentlyClickedAppIndex % recentlyClickedAppWindows.length;
    let window = recentlyClickedAppWindows[index];

    Main.activateWindow(window);
}

function resetRecentlyClickedApp() {

    if(recentlyClickedAppLoopId>0)
        Mainloop.source_remove(recentlyClickedAppLoopId);
    recentlyClickedAppLoopId=0;
    recentlyClickedApp =null;
    recentlyClickedAppWindows = null;
    recentlyClickedAppIndex = 0;

    return false;
}
