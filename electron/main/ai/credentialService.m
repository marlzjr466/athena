#import <Foundation/Foundation.h>
#import <Security/Security.h>
#include <unistd.h>
#include <sys/resource.h>
#include "credential-requirement.h"

// One request over inherited private pipes. No secrets in arguments, files or logs.
static void reply(NSDictionary *value) {
  NSData *data = [NSJSONSerialization dataWithJSONObject:value options:0 error:nil];
  if (data) fwrite(data.bytes, 1, data.length, stdout);
}
static BOOL trustedParent(void) {
  SecCodeRef parent = NULL;
  SecRequirementRef requirement = NULL;
  NSDictionary *attributes = @{(__bridge NSString *)kSecGuestAttributePid: @(getppid())};
  OSStatus status = SecCodeCopyGuestWithAttributes(NULL, (__bridge CFDictionaryRef)attributes, kSecCSDefaultFlags, &parent);
  if (status == errSecSuccess) status = SecRequirementCreateWithString(CFSTR(ATHENA_PARENT_REQUIREMENT), kSecCSDefaultFlags, &requirement);
  if (status == errSecSuccess) status = SecCodeCheckValidity(parent, kSecCSStrictValidate, requirement);
  if (requirement) CFRelease(requirement);
  if (parent) CFRelease(parent);
  return status == errSecSuccess;
}
int main(void) {
  struct rlimit noCore = {0, 0}; setrlimit(RLIMIT_CORE, &noCore);
  @autoreleasepool {
    if (!trustedParent()) { reply(@{@"ok": @NO, @"status": @(errSecAuthFailed)}); return 1; }
    NSMutableData *input = [NSMutableData data];
    unsigned char buffer[4096]; size_t count;
    while ((count = fread(buffer, 1, sizeof(buffer), stdin)) > 0) {
      if (input.length + count > 4 * 1024 * 1024) return 1;
      [input appendBytes:buffer length:count];
    }
    NSDictionary *request = [NSJSONSerialization JSONObjectWithData:input options:0 error:nil];
    if (![request isKindOfClass:NSDictionary.class]) return 1;
    NSString *service = request[@"service"], *account = request[@"account"], *operation = request[@"operation"];
    if (![service isKindOfClass:NSString.class] || ![service hasPrefix:@"com.athena.companion."] ||
        ![account isKindOfClass:NSString.class] || !account.length || service.length > 256 || account.length > 256) return 1;
    NSData *serviceData = [service dataUsingEncoding:NSUTF8StringEncoding], *accountData = [account dataUsingEncoding:NSUTF8StringEncoding];
    SecKeychainItemRef item = NULL;
    OSStatus status;
    if ([operation isEqual:@"read"]) {
      UInt32 length = 0; void *bytes = NULL;
      status = SecKeychainFindGenericPassword(NULL, (UInt32)serviceData.length, serviceData.bytes, (UInt32)accountData.length, accountData.bytes, &length, &bytes, NULL);
      if (status == errSecItemNotFound) { reply(@{@"ok": @YES, @"value": NSNull.null}); return 0; }
      if (status == errSecSuccess) {
        NSString *value = [[NSString alloc] initWithBytes:bytes length:length encoding:NSUTF8StringEncoding];
        SecKeychainItemFreeContent(NULL, bytes);
        if (!value) { reply(@{@"ok": @NO, @"status": @(errSecDecode)}); return 1; }
        reply(@{@"ok": @YES, @"value": value}); return 0;
      }
    } else if ([operation isEqual:@"write"] || [operation isEqual:@"delete"]) {
      // Looking up the item reference does not retrieve its secret.
      status = SecKeychainFindGenericPassword(NULL, (UInt32)serviceData.length, serviceData.bytes, (UInt32)accountData.length, accountData.bytes, NULL, NULL, &item);
      if ([operation isEqual:@"write"]) {
        NSString *value = request[@"value"];
        if (![value isKindOfClass:NSString.class]) { if (item) CFRelease(item); return 1; }
        NSData *data = [value dataUsingEncoding:NSUTF8StringEncoding];
        if (status == errSecSuccess) status = SecKeychainItemModifyAttributesAndData(item, NULL, (UInt32)data.length, data.bytes);
        else if (status == errSecItemNotFound) status = SecKeychainAddGenericPassword(NULL, (UInt32)serviceData.length, serviceData.bytes, (UInt32)accountData.length, accountData.bytes, (UInt32)data.length, data.bytes, NULL);
      } else {
        if (status == errSecSuccess) status = SecKeychainItemDelete(item);
        else if (status == errSecItemNotFound) status = errSecSuccess;
      }
      if (item) CFRelease(item);
      if (status == errSecSuccess) { reply(@{@"ok": @YES}); return 0; }
    } else { status = errSecParam; }
    reply(@{@"ok": @NO, @"status": @(status)}); return 1;
  }
}
