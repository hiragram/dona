#import <Foundation/Foundation.h>
#import <Security/Security.h>
#import <LocalAuthentication/LocalAuthentication.h>
#include <assert.h>
#include <stdio.h>

// Linked only into the explicit fixture binary. No real SecItem function is
// called, and there is no provisioning or OS credential mutation here.
static NSMutableDictionary *head;
static unsigned reads, writes;
static unsigned long long revision = 1;

static BOOL scenario(NSString *name) {
    return [NSProcessInfo.processInfo.environment[@"DONA_TEST_KEYCHAIN_SCENARIO"] isEqual:name];
}

static void assertBase(NSDictionary *query) {
    assert([query[(__bridge id)kSecClass] isEqual:(__bridge id)kSecClassGenericPassword]);
    assert([query[(__bridge id)kSecUseDataProtectionKeychain] isEqual:@YES]);
    LAContext *context = query[(__bridge id)kSecUseAuthenticationContext];
    assert([context isKindOfClass:[LAContext class]] && context.interactionNotAllowed);
    assert(!query[(__bridge id)kSecUseAuthenticationUI]);
}

OSStatus DonaFixtureCopyMatching(CFDictionaryRef input, CFTypeRef *result) {
    NSDictionary *query = (__bridge NSDictionary *)input;
    reads++;
    assertBase(query);
    assert([query[(__bridge id)kSecMatchLimit] isEqual:@2]);
    assert([query[(__bridge id)kSecAttrSynchronizable] isEqual:(__bridge id)kSecAttrSynchronizableAny]);
    assert([query[(__bridge id)kSecReturnData] isEqual:@YES]);
    assert([query[(__bridge id)kSecReturnAttributes] isEqual:@YES]);
    if (scenario(@"missing") || (scenario(@"readback_missing") && writes)) return errSecItemNotFound;
    if (scenario(@"locked")) return errSecInteractionNotAllowed;
    if (!head) head = [@{
        (__bridge id)kSecAttrService: query[(__bridge id)kSecAttrService],
        (__bridge id)kSecAttrAccessGroup: query[(__bridge id)kSecAttrAccessGroup],
        (__bridge id)kSecAttrAccount: @"dona-cas-v1-0000000000000001",
        (__bridge id)kSecAttrAccessible: (__bridge id)kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        (__bridge id)kSecAttrSynchronizable: @NO,
        (__bridge id)kSecValueData: [@"old" dataUsingEncoding:NSUTF8StringEncoding],
    } mutableCopy];
    if (scenario(@"bad_value_type")) head[(__bridge id)kSecValueData] = @"not-data";
    if (scenario(@"oversize")) head[(__bridge id)kSecValueData] = [NSMutableData dataWithLength:8193];
    if (scenario(@"synchronized")) head[(__bridge id)kSecAttrSynchronizable] = @YES;
    if (scenario(@"wrong_protection")) head[(__bridge id)kSecAttrAccessible] = (__bridge id)kSecAttrAccessibleAfterFirstUnlock;
    if (scenario(@"wrong_service")) head[(__bridge id)kSecAttrService] = @"other-service";
    if (scenario(@"wrong_group")) head[(__bridge id)kSecAttrAccessGroup] = @"OTHERGROUP.dev.fixture";
    if (scenario(@"wrong_account")) head[(__bridge id)kSecAttrAccount] = @"dona-cas-v1-0000000000000001\n";
    if (scenario(@"readback_drift") && writes) {
        revision = 3;
        head[(__bridge id)kSecAttrAccount] = @"dona-cas-v1-0000000000000003";
    }
    NSArray *rows = scenario(@"duplicate") ? @[head, head] : @[head];
    *result = CFBridgingRetain(rows);
    return errSecSuccess;
}

OSStatus DonaFixtureUpdate(CFDictionaryRef input, CFDictionaryRef proposed) {
    NSDictionary *query = (__bridge NSDictionary *)input, *update = (__bridge NSDictionary *)proposed;
    writes++;
    assert(writes == 1);
    assertBase(query);
    assert(!query[(__bridge id)kSecMatchLimit] && !query[(__bridge id)kSecReturnData] && !query[(__bridge id)kSecReturnAttributes]);
    assert([query[(__bridge id)kSecAttrSynchronizable] isEqual:@NO]);
    assert([query[(__bridge id)kSecAttrAccessible] isEqual:(__bridge id)kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly]);
    assert([query[(__bridge id)kSecAttrAccount] isEqual:head[(__bridge id)kSecAttrAccount]]);
    assert([query[(__bridge id)kSecAttrService] isEqual:head[(__bridge id)kSecAttrService]]);
    assert([query[(__bridge id)kSecAttrAccessGroup] isEqual:head[(__bridge id)kSecAttrAccessGroup]]);
    assert(update.count == 2 && update[(__bridge id)kSecValueData] && update[(__bridge id)kSecAttrAccount]);
    if (scenario(@"update_denied")) return errSecAuthFailed;
    revision = 2;
    head[(__bridge id)kSecAttrAccount] = update[(__bridge id)kSecAttrAccount];
    if (scenario(@"competing_update")) return errSecItemNotFound;
    head[(__bridge id)kSecValueData] = update[(__bridge id)kSecValueData];
    if (scenario(@"lost_update_reply")) return errSecIO;
    return errSecSuccess;
}

__attribute__((destructor)) static void report(void) {
    fprintf(stderr, "fixture:reads=%u,writes=%u,revision=%llu\n", reads, writes, revision);
}
