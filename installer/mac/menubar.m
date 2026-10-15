/*
 * OBS Conductor - icon in the macOS menu bar (top right of the screen).
 *
 * Started hidden by the app itself (src/tray.js), stopped with it. Every
 * 1.5 s it asks the app (http://127.0.0.1:PORT/api/tray) what to show: a
 * coloured dot (green all good, orange needs a look, red connection lost),
 * two status lines in the menu. "Quit" asks first, then calls
 * POST /api/app/quit. Built by build_mac.command (clang) into
 * OBS Conductor.app/Contents/MacOS/OBSConductorMenu.
 *
 *   OBSConductorMenu --port 8090 --parent-pid 1234 --log-file /path/to.log
 */
#import <Cocoa/Cocoa.h>
#include <errno.h>
#include <signal.h>
#include <string.h>

@interface MenuApp : NSObject <NSApplicationDelegate>
@property (strong) NSStatusItem *item;
@property (strong) NSMenuItem *line1;
@property (strong) NSMenuItem *line2;
@property (strong) NSString *level;
@property (strong) NSString *logFile;
@property (assign) int port;
@property (assign) pid_t parent;
@end

@implementation MenuApp

/* the logo (list + play triangle), drawn as a template image: macOS colours
 * it for the light / dark menu bar */
- (NSImage *)glyph {
  NSImage *img = [NSImage imageWithSize:NSMakeSize(18, 18) flipped:NO drawingHandler:^BOOL(NSRect r) {
    [[NSColor blackColor] set];
    NSBezierPath *p = [NSBezierPath bezierPath];
    p.lineWidth = 1.8;
    p.lineCapStyle = NSLineCapStyleRound;
    [p moveToPoint:NSMakePoint(2.5, 14.5)]; [p lineToPoint:NSMakePoint(15.5, 14.5)];
    [p moveToPoint:NSMakePoint(2.5, 9.0)];  [p lineToPoint:NSMakePoint(7.5, 9.0)];
    [p moveToPoint:NSMakePoint(2.5, 3.5)];  [p lineToPoint:NSMakePoint(7.5, 3.5)];
    [p stroke];
    NSBezierPath *t = [NSBezierPath bezierPath];
    [t moveToPoint:NSMakePoint(10.0, 11.5)];
    [t lineToPoint:NSMakePoint(16.0, 6.5)];
    [t lineToPoint:NSMakePoint(10.0, 1.5)];
    [t closePath];
    [t fill];
    return YES;
  }];
  img.template = YES;
  return img;
}

- (NSURL *)url:(NSString *)path {
  return [NSURL URLWithString:[NSString stringWithFormat:@"http://127.0.0.1:%d%@", self.port, path]];
}

- (void)applicationDidFinishLaunching:(NSNotification *)n {
  self.level = @"app";
  self.item = [[NSStatusBar systemStatusBar] statusItemWithLength:NSVariableStatusItemLength];
  self.item.button.image = [self glyph];
  self.item.button.imagePosition = NSImageLeft;
  self.item.button.toolTip = @"OBS Conductor";

  NSMenu *menu = [[NSMenu alloc] init];
  menu.autoenablesItems = NO;
  self.line1 = [menu addItemWithTitle:@"OBS Conductor" action:nil keyEquivalent:@""];
  self.line1.enabled = NO;
  self.line2 = [menu addItemWithTitle:@"" action:nil keyEquivalent:@""];
  self.line2.enabled = NO;
  self.line2.hidden = YES;
  [menu addItem:[NSMenuItem separatorItem]];
  NSMenuItem *open = [menu addItemWithTitle:@"Open the dock in a browser" action:@selector(openDock:) keyEquivalent:@""];
  open.target = self; open.enabled = YES;
  NSMenuItem *log = [menu addItemWithTitle:@"Show the log" action:@selector(showLog:) keyEquivalent:@""];
  log.target = self; log.enabled = YES;
  [menu addItem:[NSMenuItem separatorItem]];
  NSMenuItem *quit = [menu addItemWithTitle:@"Quit OBS Conductor" action:@selector(quitApp:) keyEquivalent:@""];
  quit.target = self; quit.enabled = YES;
  self.item.menu = menu;

  [NSTimer scheduledTimerWithTimeInterval:1.5 target:self selector:@selector(tick:) userInfo:nil repeats:YES];
  [self tick:nil];
}

- (void)setDot:(NSString *)level {
  NSColor *c = nil;
  if ([level isEqualToString:@"tray_ok"]) c = [NSColor systemGreenColor];
  else if ([level isEqualToString:@"tray_warn"]) c = [NSColor systemOrangeColor];
  else if ([level isEqualToString:@"tray_error"]) c = [NSColor systemRedColor];
  if (c) {
    NSDictionary *a = @{ NSForegroundColorAttributeName: c, NSFontAttributeName: [NSFont systemFontOfSize:11] };
    self.item.button.attributedTitle = [[NSAttributedString alloc] initWithString:@" ●" attributes:a];
  } else {
    self.item.button.attributedTitle = [[NSAttributedString alloc] initWithString:@""];
  }
}

- (void)tick:(NSTimer *)t {
  /* the app is gone (it closed, was killed): the icon goes too */
  if (self.parent > 0 && kill(self.parent, 0) != 0 && errno == ESRCH) { [NSApp terminate:nil]; return; }
  NSURLRequest *req = [NSURLRequest requestWithURL:[self url:@"/api/tray?since=0"]
                                       cachePolicy:NSURLRequestReloadIgnoringLocalCacheData timeoutInterval:1.5];
  [[[NSURLSession sharedSession] dataTaskWithRequest:req completionHandler:^(NSData *data, NSURLResponse *resp, NSError *err) {
    if (err || !data) return;
    id j = [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
    if (![j isKindOfClass:[NSDictionary class]]) return;
    NSDictionary *d = j;
    dispatch_async(dispatch_get_main_queue(), ^{
      NSString *l1 = [d[@"line1"] isKindOfClass:[NSString class]] ? d[@"line1"] : @"OBS Conductor";
      NSString *l2 = [d[@"line2"] isKindOfClass:[NSString class]] ? d[@"line2"] : @"";
      NSString *tip = [d[@"tooltip"] isKindOfClass:[NSString class]] ? d[@"tooltip"] : @"OBS Conductor";
      NSString *lv = [d[@"level"] isKindOfClass:[NSString class]] ? d[@"level"] : @"app";
      self.line1.title = l1;
      self.line2.title = l2;
      self.line2.hidden = l2.length == 0;
      self.item.button.toolTip = tip;
      if (![lv isEqualToString:self.level]) { self.level = lv; [self setDot:lv]; }
    });
  }] resume];
}

- (void)openDock:(id)sender {
  [[NSWorkspace sharedWorkspace] openURL:[self url:@"/"]];
}

- (void)showLog:(id)sender {
  if (self.logFile.length && [[NSFileManager defaultManager] fileExistsAtPath:self.logFile])
    [[NSWorkspace sharedWorkspace] openURL:[NSURL fileURLWithPath:self.logFile]];
}

- (void)quitApp:(id)sender {
  [NSApp activateIgnoringOtherApps:YES];
  NSAlert *a = [[NSAlert alloc] init];
  a.messageText = @"Quit OBS Conductor?";
  a.informativeText = @"The dock in OBS stops working until the app is started again.";
  [a addButtonWithTitle:@"Quit"];
  [a addButtonWithTitle:@"Cancel"];
  if ([a runModal] != NSAlertFirstButtonReturn) return;
  NSMutableURLRequest *req = [NSMutableURLRequest requestWithURL:[self url:@"/api/app/quit"]];
  req.HTTPMethod = @"POST";
  req.timeoutInterval = 1.5;
  dispatch_semaphore_t done = dispatch_semaphore_create(0);
  [[[NSURLSession sharedSession] dataTaskWithRequest:req completionHandler:^(NSData *d, NSURLResponse *r, NSError *e) {
    dispatch_semaphore_signal(done);
  }] resume];
  dispatch_semaphore_wait(done, dispatch_time(DISPATCH_TIME_NOW, 2 * NSEC_PER_SEC));
  [NSApp terminate:nil];
}

@end

int main(int argc, const char **argv) {
  @autoreleasepool {
    MenuApp *m = [[MenuApp alloc] init];
    m.port = 8090;
    for (int i = 1; i + 1 < argc; i++) {
      if (strcmp(argv[i], "--port") == 0) m.port = atoi(argv[i + 1]);
      else if (strcmp(argv[i], "--parent-pid") == 0) m.parent = (pid_t)atoi(argv[i + 1]);
      else if (strcmp(argv[i], "--log-file") == 0) m.logFile = [NSString stringWithUTF8String:argv[i + 1]];
    }
    NSApplication *app = [NSApplication sharedApplication];
    [app setActivationPolicy:NSApplicationActivationPolicyAccessory];   /* menu bar only: no Dock icon */
    app.delegate = m;
    [app run];
  }
  return 0;
}
